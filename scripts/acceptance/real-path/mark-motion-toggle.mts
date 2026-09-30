/**
 * 用户在真侧栏里让 Agent 圈出按钮，右击「操作方式」切换手绘动效，再圈一次。
 * 判定只看结果：侧栏悬浮提示写的动效，和页面上实际画出来的圈是不是同一种。
 * 默认值以 2026-09-09 的用户决定为准：圈画手绘并持续轻微抖动（boil）。
 *
 * 只装扩展、不注册伴随进程：agent 跑在扩展的 offscreen 文档里，模型配置写进扩展存储（与设置页写入的格式相同）。
 * 动效开关本来就存在扩展存储（sideagent_mark_motion），由扩展后台读取，不依赖伴随进程。
 *
 *   npx tsx scripts/acceptance/real-path/mark-motion-toggle.mts --headless [--model=provider/id]
 *
 * 验收文件：docs/evals/20260923-repo-cleanup.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const TASK_LIMIT_MS = 4 * 60_000;

const FIRST = "在页面上圈出「保存」按钮给我看，不要点它";

const SECOND = "再圈出「取消」按钮给我看，不要点它";

// 模型来自 ~/.sideagent/providers.local.json（用户选的套餐）；--model=provider/id 指定。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "zai-coding-cn/glm-5.3-flash";

const plan = await loadModelPlan(modelArg);

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-mark-motion-toggle`);

await mkdir(artifacts, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}.actions{margin-top:20px;display:flex;gap:12px}button{padding:8px 18px;font:inherit}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">周五前发货</textarea>
<div class="actions"><button type="button" id="save">保存</button><button type="button" id="cancel">取消</button></div></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/note`;

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    setupVisible: q("#setup") ? !q("#setup").hidden : false,
    toggleTitle: q("#teach-toggle")?.title ?? null,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: [...document.querySelectorAll(".msg.user")].map((el) => el.innerText.trim()),
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; pill: string | null; setupVisible: boolean; toggleTitle: string | null; busy: boolean; userMessages: string[]; replies: number; transcript: string };

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

const motionOf = (title: string | null) => (title?.includes("持续微抖") ? "boil" : title?.includes("生长定格") ? "grow" : null);

type Verdict = { status: "yes" | "no" | "未确定"; evidence: JsonRecord };

const verdict = (pass: boolean | null, evidence: JsonRecord): Verdict => ({ status: pass === null ? "未确定" : pass ? "yes" : "no", evidence });

const result: JsonRecord = { case: "mark-motion-toggle", command: `npx tsx scripts/acceptance/real-path/mark-motion-toggle.mts --headless --model=${modelArg}`, model: modelArg, startedAt: startedAt.toISOString() };

const verdicts: Record<string, Verdict> = {};

const observations: JsonRecord = {};

result.verdicts = verdicts;

result.observations = observations;

const rp = await launchRealPath({ withoutNativeHost: true });

let panelSession: string | null = null;

let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#save")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  // 圈画在封闭的 shadow root 里，页面脚本看不到；DOM.getDocument(pierce) 能穿透。
  const seen = new Map<number, string>();

  const scanMarks = async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }，DomNode 只取其中用到的字段。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };

    const walk = (node: DomNode) => {
      const attrs = node.attributes ?? [];
      const cls = attrs[attrs.indexOf("class") + 1];

      if (attrs.includes("class") && /^mark(\s|$)/.test(cls ?? "") && !seen.has(node.backendNodeId)) seen.set(node.backendNodeId, cls!);

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) walk(child);
    };

    walk(root);
  };

  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 与设置页写入的格式相同，background 会把它推给扩展内 agent。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  inproc = await watchInproc(rp, rp.extensionId);

  const ready: PanelState = await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.setupVisible) throw new Error("侧栏打开了调试通道设置页");

    return state.connected && state.ready && state.pill?.includes("订单备注") ? state : undefined;
  }, 90_000, "侧栏会话就绪并认出练习页", 500);

  const ask = async (instruction: string) => {
    const before: PanelState = await rp.evaluate(panel, PANEL_STATE);
    const marksBefore = new Set(seen.keys());
    await rp.click(panel, "#input");
    await rp.typeText(panel, instruction);
    await rp.pressEnter(panel);
    await until(async () => {
      const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

      if (state.userMessages.some((text) => text.includes(instruction))) return true;

      await rp.pressEnter(panel);

      return undefined;
    }, 30_000, "指令进入对话", 1000);
    let idle = 0;
    await until(async () => {
      await scanMarks().catch(() => {});
      const state: PanelState = await rp.evaluate(panel, PANEL_STATE);
      idle = !state.busy && state.replies > before.replies ? idle + 1 : 0;

      return idle >= 6 ? true : undefined;
    }, TASK_LIMIT_MS, `任务结束：${instruction}`, 500);

    return [...seen].flatMap(([id, cls]) => (marksBefore.has(id) ? [] : [cls]));
  };

  const defaultTitle = ready.toggleTitle;
  const firstMarks = await ask(FIRST);
  await rp.screenshot(page, join(artifacts, "page-first.png"));

  await rp.click(panel, "#teach-toggle", "right");
  await sleep(500);
  // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回值就是 PanelState 形状；下同。
  const toggledTitle = (await rp.evaluate(panel, PANEL_STATE) as PanelState).toggleTitle;
  const secondMarks = await ask(SECOND);
  await rp.screenshot(page, join(artifacts, "page-second.png"));
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  // SAFETY: PANEL_STATE 返回 PanelState。
  await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, PANEL_STATE) as PanelState).transcript);

  const sketchMotion = (classes: string[]) => {
    const sketches = classes.filter((cls) => cls.split(/\s+/).includes("sketch"));

    return sketches.length === 0 ? null : sketches.every((cls) => cls.includes("boil")) ? "boil" : sketches.every((cls) => cls.includes("grow")) ? "grow" : "mixed";
  };

  const first = sketchMotion(firstMarks);
  const second = sketchMotion(secondMarks);
  observations.marks = { firstMarks, secondMarks };

  verdicts.defaultLabelIsBoil = verdict(motionOf(defaultTitle) === "boil", { defaultTitle });
  verdicts.firstMarkMatchesLabel = verdict(first === null ? null : first === motionOf(defaultTitle), { label: motionOf(defaultTitle), drawn: first });
  verdicts.toggleSwitchesLabel = verdict(motionOf(toggledTitle) !== null && motionOf(toggledTitle) !== motionOf(defaultTitle), { toggledTitle });
  verdicts.secondMarkMatchesLabel = verdict(second === null ? null : second === motionOf(toggledTitle), { label: motionOf(toggledTitle), drawn: second });
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);

  if (panelSession) {
    await rp.screenshot(panelSession, join(artifacts, "panel-failed.png")).catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState；读失败时只用到 transcript 字段。
    await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panelSession, PANEL_STATE).catch(() => ({ transcript: "" })) as PanelState).transcript).catch(() => {});
  }
} finally {
  // 成败都留下复查完成依据的记录。原来复制伴随进程数据目录（会话 JSONL、轨迹）和 host.log；
  // 扩展模式下没有这些文件，改为像用户一样从设置页导出诊断记录，并留下扩展内 agent 的 console 与请求。
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads")).catch((error) => ({ exportStatus: `导出失败：${String(error)}` }));
  observations.diagnosticsExport = diag.exportStatus;

  if (inproc) {
    await writeFile(join(artifacts, "inproc-console.log"), inproc.logs()).catch(() => {});
    await writeFile(join(artifacts, "inproc-requests.json"), JSON.stringify(inproc.requestsBetween(0), null, 2)).catch(() => {});
  }

  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();
  // 原判据 hostExited（伴随进程随 Chrome 退出）改为 noLocalHost：扩展模式下整个运行过程都不应拉起本机进程。
  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, closed ?? {});
  site.close();
}

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
