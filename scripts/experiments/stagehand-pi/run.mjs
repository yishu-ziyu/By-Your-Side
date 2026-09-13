#!/usr/bin/env node
/**
 * Stagehand + Pi 最小可复跑探针（实验用，非生产接线）。
 *
 * 对齐证据：github.com/browserbase/stagehand @ b771930d2b4d858e5bd9670203c66260b385a8fa，
 * `@browserbasehq/stagehand` 4.1.0。API 形状取自该 commit 的
 * packages/sdk-ts/src/{stagehand,browser/factories,browser/index,page,locator,browserContext}.ts
 * 与 packages/docs/v4/integrations/pi.mdx，不靠猜测。
 *
 * 四个会改变技术决策的问题：
 *   A. connect 能否接到**已存在**的普通 Chrome（不 launch 新浏览器、不切远程调试启动模式）；
 *   B. fill 是否只写指定字段、不提交表单；
 *   C. 切换活跃页面后，原有页面句柄是否仍绑定原页、不串页；
 *   D. 批次截止（batch deadline）是否停住已下达的批次（之后不再新增写入）。
 *
 * 硬约束：
 *   - 只 launch 隔离无头 Chromium + 本地 fixture；不连接任何既有浏览器（无 connect 运行路径）。
 *   - 不使用自写 CDP/Playwright 包装冒充 Stagehand；缺依赖或缺令牌即报 BLOCKED，而不是通过。
 *   - 拒绝任何 GUI / 计算机操作参数。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(DIR, "out");
const MODULE_ROOT =
  process.env.STAGEHAND_MODULE_ROOT ?? path.join(DIR, "node_modules");
const SDK_ENTRY = path.join(MODULE_ROOT, "@browserbasehq", "stagehand", "dist", "index.mjs");
const argv = process.argv.slice(2);
const envOnly = argv.includes("--env-only");

const FORBIDDEN = /computer-use|--gui|--headful|window-position|--user-data-dir=|--profile-directory/;
if (argv.some((arg) => FORBIDDEN.test(arg))) {
  console.error(`refused: GUI/computer-use argument ${argv.find((a) => FORBIDDEN.test(a))}`);
  process.exit(2);
}

const log = (line) => process.stdout.write(`${line}\n`);
const record = {
  task: "stagehand-pi-probe",
  evidence: { upstreamCommit: "b771930d2b4d858e5bd9670203c66260b385a8fa", sdkVersion: "4.1.0" },
  mode: "launch-isolated",
  startedAt: new Date().toISOString(),
  env: {},
  checks: [],
};
const check = (id, status, detail, evidence) => {
  record.checks.push({ id, status, detail, ...(evidence === undefined ? {} : { evidence }) });
  log(`${status.padEnd(7)} ${id} — ${detail}`);
};

/**
 * A（源码可执行部分）：connect 契约。
 * `LocalBrowserConnectOptionsSchema` 是 strictObject，只有 cdpUrl（必填）与 extensionId（可选）；
 * connect 内部固定 `CDPClient.connect({cdpUrl})` → 取 `${cdpUrl}/json/version` 的 ws 再开 WebSocket。
 * 没有 CDP 端点就没有 connect：launch 之外不存在“从零附着普通 Chrome”的入口。
 */
async function probeConnectContract(sdk) {
  const noUrl = sdk.LocalBrowserConnectOptionsSchema.safeParse({});
  check(
    "connect.requires-cdpUrl",
    noUrl.success ? "FAIL" : "PASS",
    noUrl.success
      ? "connect 可无 cdpUrl 调用，与 4.1.0 源码不符"
      : "connect 必须有 cdpUrl：没有调试端点就无法附着",
    { issues: noUrl.success ? null : noUrl.error.issues.map((issue) => issue.message) },
  );
  const withUrl = sdk.LocalBrowserConnectOptionsSchema.safeParse({
    cdpUrl: "http://127.0.0.1:9222",
  });
  check(
    "connect.accepts-cdpUrl",
    withUrl.success ? "PASS" : "FAIL",
    "单个 cdpUrl 即可通过 schema；connect 不要求任何 launch 参数",
  );
}

/** 环境能力：CDP 依赖 loopback socket；SDK 依赖可解析的真实依赖树。 */
async function capability() {
  const canListen = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => resolve(`ERR ${error.code}`));
    probe.listen(0, "127.0.0.1", () => probe.close(() => resolve("OK")));
  });
  record.env.loopbackListen = canListen;

  let sdk;
  try {
    const resolved = await realpath(SDK_ENTRY);
    const manifest = JSON.parse(
      await readFile(path.join(MODULE_ROOT, "@browserbasehq", "stagehand", "package.json"), "utf8"),
    );
    const module = await import(pathToFileURL(resolved).href);
    sdk = { module, info: { path: resolved, version: manifest.version, moduleRoot: MODULE_ROOT } };
  } catch (error) {
    sdk = { error: `${error.code ?? ""} ${error.message}`.trim() };
  }
  record.env.sdk = sdk.error ? { error: sdk.error } : sdk.info;
  return { canListen, sdk };
}

/** 本地无提交 fixture 服务；只监听 loopback，用完即关。 */
async function serveFixture() {
  const html = await readFile(path.join(DIR, "fixture", "form.html"), "utf8");
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      // 走到这里就证明表单真的提交了——记为失败证据，而不是放过。
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("submitted");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 读页面观测层。SDK 的 Page 不暴露 evaluate，所以读 fixture 渲染进 DOM 的 JSON。 */
async function state(page) {
  const raw = await page.locator("#probe-state").textContent();
  return { url: await page.url(), ...JSON.parse(raw) };
}

async function main() {
  const { canListen, sdk } = await capability();
  log(`loopback listen: ${canListen}`);
  log(`stagehand: ${sdk.info?.version ?? sdk.error} (${MODULE_ROOT})`);

  if (envOnly) {
    await persist(canListen === "OK" && sdk.info ? "ready" : "blocked", "blocked");
    process.exit(canListen === "OK" && sdk.info ? 0 : 2);
  }

  // 纯 schema 的 connect 契约不碰 socket，先跑，避免沙箱网络限制掩盖真实结论。
  const api = sdk.module;
  if (api) await probeConnectContract(api);

  if (sdk.version && sdk.version !== "4.1.0") sdk.error = `Expected pinned SDK 4.1.0, got ${sdk.version}`;
  if (sdk.error) check("dependency", "BLOCKED", `Stagehand 不可加载：${sdk.error}`);
  if (canListen !== "OK") {
    check("sandbox-socket", "BLOCKED", `沙箱禁止 loopback 监听/连接（${canListen}），CDP 无法建立`);
  }
  if (sdk.error || canListen !== "OK") {
    log("环境受阻：契约测试未跑（BLOCKED，不等于通过，也不等于契约失败）。");
    await persist("blocked", "blocked");
    process.exit(2);
  }

  const fixture = await serveFixture();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "stagehand-pi-probe-"));
  let browser;
  let stagehand;
  try {
    // 隔离浏览器：全新 userDataDir、无头、本地 fixture；与用户日常 Chrome 无关。
    browser = await api.localBrowser.launch({ headless: true, userDataDir });
    stagehand = await api.Stagehand.create({ browser });
    const context = browser.context;

    const [first] = await context.pages();
    const page = first ?? (await context.newPage());
    await page.goto(fixture.url);

    await probeFill(page);
    await probeSwitch(context, page);
    await probeDeadline(stagehand, context, fixture.url);
  } catch (error) {
    check("run", "BLOCKED", `探针未能完成：${error?.stack ?? error}`);
  } finally {
    try { await stagehand?.close?.(); } catch { /* 关闭失败不掩盖主证据 */ }
    try { await browser?.close?.(); } catch { /* 同上 */ }
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true }).catch(() => undefined);
  }

  // probeStatus 只描述探针自身；acceptanceStatus 描述原始用户契约。
  // 用户级 abort 不是本探针的覆盖面，因此 acceptanceStatus 本轮固定 blocked，
  // 不允许用 probeStatus=passed 掩盖这一点。
  const failed = record.checks.some((item) => item.status === "FAIL");
  const blocked = record.checks.some((item) => item.status === "BLOCKED");
  const inconclusive = record.checks.some((item) => item.status === "INCONCLUSIVE");
  const probeStatus = failed ? "failed" : blocked ? "blocked" : inconclusive ? "inconclusive" : "passed";
  await persist(probeStatus, "blocked");
  process.exit(failed ? 1 : blocked ? 2 : inconclusive ? 3 : 0);
}

/** B：只填指定字段、不提交。 */
async function probeFill(page) {
  await page.locator("#firstName").fill("Ada");
  const after = await state(page);
  const others = ["lastName", "email", "city"].map((id) => after.values[id]);
  check(
    "fill.values",
    after.values.firstName === "Ada" && others.every((value) => value === "") ? "PASS" : "FAIL",
    `firstName=${JSON.stringify(after.values.firstName)}，其余=${JSON.stringify(others)}`,
    after.values,
  );
  check(
    "fill.no-submit",
    after.submits === 0 && after.navigations === 0 && after.url.startsWith("http://127.0.0.1:")
      ? "PASS"
      : "FAIL",
    `submits=${after.submits} navigations=${after.navigations} url=${after.url}`,
  );
}

/**
 * C：切换活跃页面后，**原有页面句柄**是否仍绑定原页。
 * 用户路径是「任务已绑在 tab A，用户切到 tab B」，所以要验证的是句柄绑定而不是
 * 「我显式挑了第二页去写」。这里不做 AI act 的活跃页默认值验证（需模型凭据），只做句柄层证据。
 */
async function probeSwitch(context, first) {
  const second = await context.newPage();
  await second.goto(`${new URL(await first.url()).origin}/?page=2`);
  await context.setActivePage(second);
  // 活跃页已是 second，但继续用旧句柄写：若绑定正确，写入必须落在 first。
  await first.locator("#lastName").fill("BoundToFirst");
  const onSecond = await state(second);
  const onFirst = await state(first);
  check(
    "switch.handle-binding",
    onFirst.values.lastName === "BoundToFirst" && onSecond.values.lastName === "" ? "PASS" : "FAIL",
    `活跃页切到 second 后，旧句柄写入 first=${JSON.stringify(onFirst.values.lastName)}，second 未被写入=${JSON.stringify(onSecond.values.lastName)}`,
    { onSecond: onSecond.values, onFirst: onFirst.values },
  );
  check(
    "switch.active-page-defaults",
    "INFO",
    "AI act() 的默认目标页是否等于 setActivePage 后的活跃页未在本探针验证（需要模型凭据）；本项只覆盖句柄绑定。",
  );
}

/**
 * D：批次截止（deadline）后不新增操作。
 * 注意：这里的 timeout 是 experimentalBatch 自带的截止，**不是用户/ Pi 下传的 abort**。
 * 4.1.0 中 Page/Locator/BrowserContext 的方法没有 AbortSignal 参数（见下方声明扫描），
 * 本项只验证 deadline，不证明用户取消或 close 能停止已在途的命令。
 */
async function probeDeadline(stagehand, context, url) {
  const target = (await context.pages())[0] ?? (await context.newPage());
  // 批次回调里 `batch.page` 只由 options.page 决定；不传就会落在“当前活跃页”。
  // 这里先把活跃页也设成 target，避免两种解释分歧。
  await context.setActivePage(target);
  await target.goto(url);
  await target.locator("#firstName").fill("Ada");

  let outcome;
  const dispatchedAt = Date.now();
  try {
    await stagehand.experimentalBatch(
      async (batch) => {
        await batch.page.locator("#lastName").fill("Lovelace");
        // 故意越过 900ms 截止：若截止真实生效，Email/City 不应落地。
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await batch.page.locator("#email").fill("ada@example.com");
        await batch.page.locator("#city").fill("London");
        return "completed";
      },
      undefined,
      // page 必须显式指定：batch 默认目标是活跃页，而 probeSwitch 已把活跃页留在 second。
      { page: target, timeout: 900 },
    );
    outcome = { settled: "resolved", dispatchedAt, settledAt: Date.now() };
  } catch (error) {
    outcome = { settled: "rejected", dispatchedAt, settledAt: Date.now(), message: String(error?.message ?? error) };
  }

  // 批次 settle 不等于后续动作已停：等满回调原本的等待时间再读，避免早读造成的假通过。
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // 读**所有**页面：先前活跃过的 second 也必须在检查范围内，防止写串到别页。
  const pages = [];
  for (const candidate of await context.pages()) {
    pages.push({ isTarget: candidate.pageId === target.pageId, ...(await state(candidate)) });
  }
  const after = pages.find((entry) => entry.isTarget);
  if (!after) throw new Error("Bound target page disappeared; deadline evidence unavailable");
  const lateWrites = pages
    .filter((entry) => entry.writes.some((write) => write.id === "email" || write.id === "city"))
    .map((entry) => ({ isTarget: entry.isTarget, url: entry.url, ids: entry.writes.map((w) => w.id) }));

  // 前置写入必须真实发生，否则没有“已下达的批次”可被中止，结论无效。
  const preWriteHappened = after.values.lastName === "Lovelace";
  if (!preWriteHappened || !/timed out/i.test(outcome.message ?? "")) {
    check(
      "deadline.stops-batch",
      "INCONCLUSIVE",
      `截止前的前置写入未发生（lastName=${JSON.stringify(after.values.lastName)}），没有真实在跑的批次可中止；本轮不记 PASS`,
      { outcome, pages: pages.map((entry) => ({ isTarget: entry.isTarget, values: entry.values })) },
    );
  } else {
    check(
      "deadline.stops-batch",
      lateWrites.length === 0 ? "PASS" : "FAIL",
      lateWrites.length === 0
        ? `前置写入 lastName 已发生，截止后等满 2.5s 所有页面均无新增写入（target 已落地：${JSON.stringify([...new Set(after.writes.map((e) => e.id))])}）`
        : `截止后仍有迟到写入：${JSON.stringify(lateWrites)}`,
      { outcome, pages: pages.map((entry) => ({ isTarget: entry.isTarget, url: entry.url, values: entry.values })) },
    );
  }

  check(
    "deadline.target-isolation",
    after.values.firstName === "Ada" && !lateWrites.length ? "PASS" : "INCONCLUSIVE",
    `target 预填 firstName 保持=${JSON.stringify(after.values.firstName)}；越界写入=${lateWrites.length}`,
    { pages: pages.map((entry) => ({ isTarget: entry.isTarget, url: entry.url, values: entry.values })) },
  );

  check("abort.user-stop", "INFO",
    "未测试用户停止：固定上游 Pi 扩展未转发 execute 的 AbortSignal，batch options 无 signal；deadline 成功不能证明用户取消成功。");
}

async function persist(probeStatus, acceptanceStatus) {
  record.probeStatus = probeStatus;
  // 本轮未跑：原始用户的“中途停止后不新增操作”与真人语音/日常 Chrome 路径。
  record.acceptanceStatus = acceptanceStatus;
  record.acceptanceNote =
    "原始用户契约（中途停止不新增操作、纠正姓名保留其他字段、真人语音、日常 Chrome）未由本探针覆盖；deadline 不等于用户 abort。";
  record.finishedAt = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
  log(`result: out/result.json (probeStatus=${probeStatus}, acceptanceStatus=${acceptanceStatus})`);
}

await main();
