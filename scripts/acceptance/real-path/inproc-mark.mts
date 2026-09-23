/**
 * 实验 1：只装扩展、不装伴随进程，agent 跑在扩展里，能不能完成「圈出保存按钮」。
 *
 * 隔离 Chrome 不注册 Native Messaging；模型配置写进扩展存储，相当于用户在设置里填好了
 * 用户选的套餐。判定只看结果：页面上的新圈画是否盖住「保存」，按钮没被点，没有拉起本机进程。
 *
 * --via-settings：不直接写存储，像用户一样从侧栏菜单打开设置页，点选服务商、填 key 和模型、测试连接、保存。
 * --via-settings=custom：同一个服务当成「自定义 OpenAI 兼容地址」填写。
 *
 *   npx tsx scripts/acceptance/real-path/inproc-mark.mts --headless [--model=provider/id] [--via-settings[=custom]]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const INSTRUCTION = "在页面上圈出「保存」按钮给我看，不要点它";

const TASK_LIMIT_MS = 4 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-mark`);

await mkdir(artifacts, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}.actions{margin-top:20px;display:flex;gap:12px}button{padding:8px 18px;font:inherit}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">周五前发货</textarea>
<div class="actions"><button type="button" id="save">保存</button><button type="button" id="cancel">取消</button></div>
<script>window.receipts={save:[],cancel:[]};for(const id of ["save","cancel"])for(const t of ["pointerdown","mousedown","click"])document.getElementById(id).addEventListener(t,()=>receipts[id].push(t));</script></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

// SAFETY: 监听的是 TCP 地址，address() 返回 AddressInfo。
const pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/note`;

// 模型来自 ~/.sideagent/providers.local.json（用户选的套餐）；--model provider/id 指定，默认 OpenCode Go 的 mimo-v2.6-flash。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "opencode-go/mimo-v2.6-flash";

const viaSettings = process.argv.find((arg) => arg === "--via-settings" || arg.startsWith("--via-settings="));

const plan = await loadModelPlan(modelArg);

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming")),
    userMessages: [...document.querySelectorAll(".msg.user")].map((el) => el.innerText.trim()),
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; pill: string | null; busy: boolean; userMessages: string[]; replies: number; transcript: string };

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

type Evidence = { [key: string]: Json };

type Verdict = { status: "yes" | "no"; evidence: Evidence };

const verdicts: Record<string, Verdict> = {};

const verdict = (pass: boolean, evidence: Evidence): Verdict => ({ status: pass ? "yes" : "no", evidence });

interface MarkResult {
  case: "inproc-mark"; startedAt: string; model: string | undefined; viaSettings: string | null; verdicts: Record<string, Verdict>;
  idle?: Evidence; killWorker?: Evidence; taskSeconds?: number; error?: string; finishedAt?: string; ok?: boolean;
}

const result: MarkResult = { case: "inproc-mark", startedAt: startedAt.toISOString(), model: modelArg, viaSettings: viaSettings ?? null, verdicts };

const rp = await launchRealPath({ withoutNativeHost: true });

let panel: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#save")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const panelSession = panel;

  if (viaSettings) {
    const asCustom = viaSettings === "--via-settings=custom";
    const run = await configureViaSettings(rp, panelSession, plan, { asCustom });
    const expected = asCustom ? "custom" : plan.providerId;
    verdicts.settingsTestPassed = verdict(run.testStatus.startsWith("连接正常"), { testStatus: run.testStatus });
    verdicts.settingsSaved = verdict(run.stored?.provider === expected && run.stored?.modelId === plan.modelId, { saveStatus: run.saveStatus, stored: run.stored, menuClicks: run.menuClicks, menuToggles: run.menuToggles });
    await rp.screenshot(await rp.attach(run.settingsTargetId), join(artifacts, "settings.png"));
    // 用户配好后回到原页面：关掉设置页，练习页重新成为当前标签页。
    await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
  } else {
    // 快速路径：与设置页写入的格式相同，background 会把它推给扩展内 agent。
    await rp.evaluate(panelSession, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  }

  await until(async () => {
    const state: PanelState = await rp.evaluate(panelSession, PANEL_STATE);

    return state.connected && state.pill?.includes("订单备注") ? state : undefined;
  }, 60_000, "侧栏连上扩展内 agent 并认出练习页", 500);

  const marks = new Map<number, number[]>();

  const readMarks = async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };
    const ids: number[] = [];

    const walk = (node: DomNode) => {
      const a = node.attributes ?? [];
      const i = a.indexOf("class");

      if (i >= 0 && /(^|\s)mark(\s|$)/.test(a[i + 1] ?? "")) ids.push(node.backendNodeId);

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);

    for (const id of ids) {
      if (marks.has(id)) continue;
      // SAFETY: CDP 规范里 DOM.getBoxModel 返回 { model: BoxModel }；读失败记为 null。
      const box = await rp.cdp.send("DOM.getBoxModel", { backendNodeId: id }, page).catch(() => null) as { model?: { border: number[] } } | null;

      if (box?.model?.border) marks.set(id, box.model.border);
    }
  };

  // --idle=N：配好后先闲置 N 秒再发任务（MV3 的 service worker 空闲约 30 秒会被 Chrome 停掉）。
  const idleSeconds = Number(process.argv.find((arg) => arg.startsWith("--idle="))?.slice(7) ?? 0);

  if (idleSeconds > 0) {
    const workerBefore = (await rp.serviceWorker())?.targetId ?? null;
    await sleep(idleSeconds * 1000);
    result.idle = { seconds: idleSeconds, workerBefore, workerAfter: (await rp.serviceWorker())?.targetId ?? null };
  }

  // --kill-worker：强制停掉 service worker（模拟 Chrome 更新、崩溃），看侧栏与扩展内 agent 能否自己接上。
  if (process.argv.includes("--kill-worker")) {
    const workerBefore = (await rp.serviceWorker())?.targetId ?? null;
    await rp.cdp.send("ServiceWorker.enable", {}, page);
    await rp.cdp.send("ServiceWorker.stopAllWorkers", {}, page);
    await sleep(3000);
    result.killWorker = { workerBefore, workerAfterStop: (await rp.serviceWorker())?.targetId ?? null };
  }

  const began = Date.now();
  await rp.click(panelSession, "#input");
  await rp.typeText(panelSession, INSTRUCTION);
  await rp.pressEnter(panelSession);
  // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回 PanelState。
  await until(async () => ((await rp.evaluate(panelSession, PANEL_STATE)) as PanelState).userMessages.some((t) => t.includes(INSTRUCTION)), 15_000, "指令进入对话");
  let idle = 0;
  await until(async () => {
    await readMarks().catch(() => {});
    const state: PanelState = await rp.evaluate(panelSession, PANEL_STATE);
    idle = !state.busy && state.replies > 0 ? idle + 1 : 0;

    return idle >= 6 ? true : undefined;
  }, TASK_LIMIT_MS, "任务结束", 500);
  result.taskSeconds = Math.round((Date.now() - began) / 1000);

  await rp.screenshot(page, join(artifacts, "page.png"));
  await rp.screenshot(panelSession, join(artifacts, "panel.png"));
  const final: PanelState = await rp.evaluate(panelSession, PANEL_STATE);
  await writeFile(join(artifacts, "panel-transcript.txt"), final.transcript);

  // 判据独立于产品定位逻辑：用 Chrome 自己算的盒子比较圈和按钮。
  // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 1 }, page) as { root: { nodeId: number } };
  // SAFETY: CDP 规范里 DOM.querySelector 返回 { nodeId }。
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#save" }, page) as { nodeId: number };
  // SAFETY: CDP 规范里 DOM.getBoxModel 返回 { model: BoxModel }。
  const saveBox = (await rp.cdp.send("DOM.getBoxModel", { nodeId }, page) as { model: { border: number[] } }).model.border;
  const rect = (q: number[]) => ({ x0: Math.min(q[0]!, q[6]!), y0: Math.min(q[1]!, q[3]!), x1: Math.max(q[2]!, q[4]!), y1: Math.max(q[5]!, q[7]!) });
  const s = rect(saveBox);
  const covering = [...marks.values()].flatMap((q) => [rect(q)]).filter((m) => m.x0 <= s.x0 + 2 && m.y0 <= s.y0 + 2 && m.x1 >= s.x1 - 2 && m.y1 >= s.y1 - 2 && (m.x1 - m.x0) < (s.x1 - s.x0) * 3);
  const receipts = await rp.evaluate(page, "window.receipts");

  verdicts.markCoversSave = verdict(covering.length > 0, { save: s, marks: [...marks.values()].map(rect) });
  verdicts.saveNotClicked = verdict(receipts.save.length === 0 && receipts.cancel.length === 0, { receipts });
  verdicts.repliedWithoutError = verdict(final.replies > 0 && !/还没有配置模型|找不到模型|出错|错误|失败|failed|error|\b[45]\d\d\b/i.test(final.transcript), { transcript: final.transcript.slice(-600) });
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);

  if (panel) {
    await rp.screenshot(panel, join(artifacts, "panel-failed.png")).catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState；读失败时只用到 transcript 字段。
    await writeFile(join(artifacts, "panel-transcript.txt"), ((await rp.evaluate(panel, PANEL_STATE).catch(() => ({ transcript: "" }))) as PanelState).transcript).catch(() => {});
  }
} finally {
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();
  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, closed ?? {});
  site.close();
}

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

if (result.idle) console.log(`闲置：${JSON.stringify(result.idle)}`);

if (result.killWorker) console.log(`停 worker：${JSON.stringify(result.killWorker)}`);

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  用时：${String(result.taskSeconds ?? "-")} 秒  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence).slice(0, 300)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
