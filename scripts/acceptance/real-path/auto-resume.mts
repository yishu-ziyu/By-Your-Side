/**
 * 后台重启后自动接着做：任务填到第 3 个输入框时只关掉扩展内 agent（offscreen 文档），不动浏览器和标签页。
 * 安全的任务（中断原因是重启/断连、没有不确定是否已执行的步骤、原页面还在）应自己接着填完 4、5，不用用户点「继续原任务」；
 * 已填的 1–3 每个只填一次。
 *
 *   npx tsx scripts/acceptance/real-path/auto-resume.mts --headless
 *
 * 模型是本机脚本；侧栏、扩展、会话存储、页面都是真实路径。产物：before.png、after.png、result.json。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, type Json, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const GOAL = "自动接续验收：把这页 5 个输入框依次填好。";

/** 页面每收到一次 change 就报给本机服务：服务端按字段计数，判断有没有重复填写。 */
const fills: Record<string, number> = {};

const html = `<!doctype html><meta charset="utf-8"><title>五个输入框</title>${[1, 2, 3, 4, 5].map((i) => `<p><label>字段${i} <input id="f${i}" name="f${i}"></label></p>`).join("")}
<script>document.addEventListener("change", (e) => fetch("/fill?f=" + e.target.id, { method: "POST" }));</script>`;

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");


  if (url.pathname !== "/fill") { res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html);

    return; }

  const f = url.searchParams.get("f") ?? "?";
  fills[f] = (fills[f] ?? 0) + 1;
  res.writeHead(204).end();
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const fill = (i: number, delayMs = 0) => ({ tool: { name: "fill", args: { target: `#f${i}`, value: `值${i}` } }, delayMs });

// 第 4 步挂起几秒：关掉 offscreen 时模型这一步还没回。
const model = await startScriptedModel([{ match: "自动接续验收", steps: [fill(1), fill(2), fill(3), fill(4, 6000), fill(5), { text: "5 个都填好了。" }] }]);

const out = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + "-auto-resume");

await mkdir(out, { recursive: true });

const rp = await launchRealPath();

let panel = "", failure: string | null = null;

let logs: Awaited<ReturnType<typeof watchInproc>> | undefined;

/** result.json 的内容。 */
type Evidence = { before?: Json; after?: Json; pass?: boolean; failure?: string; modelRequests?: Json };

const evidence: Evidence = {};

// SAFETY: 表达式返回的就是这两个字符串字段。
const state = () => rp.evaluate(panel, `(() => { const r = document.querySelector("#resume-entry-root");
  return { resumeText: r?.hidden ? "" : r?.innerText.trim() ?? "", messages: document.querySelector("#messages")?.innerText ?? "" }; })()`) as Promise<{ resumeText: string; messages: string }>;

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`) || undefined, 30_000, "侧栏可发送");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "test-key" } }, { asCustom: true, baseUrl: model.baseUrl });
  logs = await watchInproc(rp, rp.extensionId);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL);
  await rp.pressEnter(panel);

  // SAFETY: 表达式返回 5 个输入框的 value 字符串。
  const values = () => rp.evaluate(work, `[1,2,3,4,5].map((i) => document.querySelector("#f" + i).value)`) as Promise<string[]>;
  await until(async () => (fills.f3 ?? 0) > 0 || undefined, 30_000, "字段 3 已填");
  await sleep(500);
  evidence.before = { values: await values(), fills: { ...fills } };
  await rp.screenshot(panel, join(out, "before.png"));

  // 只重启扩展内 agent：关掉 offscreen 文档，浏览器、标签页、侧栏都留着。
  const inproc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
  assert.ok(inproc, "找不到 offscreen 文档");
  await rp.cdp.send("Target.closeTarget", { targetId: inproc.targetId });
  const closedAt = Date.now();

  const filled = await until(async () => { const v = await values();

    return v[3] && v[4] ? v : undefined; }, 45_000, "字段 4、5 自动填好").catch(async () => values());

  evidence.after = { values: filled, fills: { ...fills }, secondsAfterRestart: (Date.now() - closedAt) / 1000, panel: await state() };
  await rp.screenshot(panel, join(out, "after.png"));
  assert.deepEqual(filled, ["值1", "值2", "值3", "值4", "值5"], `重启后没有自己接着填完：${JSON.stringify(filled)}；侧栏：${JSON.stringify((await state()).resumeText)}`);
  assert.deepEqual([fills.f1, fills.f2, fills.f3], [1, 1, 1], `字段 1–3 被重复填写：${JSON.stringify(fills)}`);
  evidence.pass = true;
} catch (e) {
  failure = String(e); evidence.pass = false; evidence.failure = failure;

  await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
  console.error(e);
} finally {
  if (logs) await writeFile(join(out, "inproc.log"), logs.logs()).catch(() => {});
  evidence.modelRequests = model.requests;
  await writeFile(join(out, "result.json"), JSON.stringify(evidence, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(out);

if (failure) process.exitCode = 1;
