/** 真侧栏 → 真模型请求点选 → 可信鼠标指向 → 真标注；Esc 分支不得猜目标。 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { REPO, launchRealPath, modelReplies, requireHeadless, sha256File, siteAddress, snapshotDir, until } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";

requireHeadless();

const startedAt = new Date().toISOString();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.replace(/[:.]/g, "-")}-point-then-mark`);

await mkdir(artifacts, { recursive: true });

const dailyDistBefore = await sha256File(join(REPO, "extension/dist/background.js"));

const checks: Record<string, boolean> = {};

const evidence: JsonRecord = {};

let failure: string | undefined;

const pageHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>点选练习</title>
<style>body{font:16px/1.6 -apple-system,sans-serif;margin:72px 40px}button{font:inherit;padding:14px 24px}#cancel{margin-left:180px}</style>
<h1>订单操作</h1><p>这里的按钮会记录收到的输入事件。</p>
<button id="save">保存</button><button id="cancel"><span>取消</span></button>
<script>window.receipts={save:[],cancel:[]};for(const id of ['save','cancel'])for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.getElementById(id).addEventListener(type,e=>receipts[id].push({type,trusted:e.isTrusted}));</script></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const url = `http://127.0.0.1:${siteAddress(site).port}/point`;

type Node = { backendNodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };

type Panel = { connected: boolean; title: string; busy: boolean; users: string[]; replies: number; transcript: string };

const panelState = `(() => ({
  connected: !!document.querySelector('#status-dot.on'), title: document.querySelector('#tab-title-text')?.textContent ?? '',
  busy: !!document.querySelector('#status-pill.running, #send-btn.stopping, .msg.assistant.streaming, .msg.assistant[data-revealing]'),
  users: [...document.querySelectorAll('.msg.user')].map(x=>x.innerText),
  replies: document.querySelectorAll('#messages .msg:not(.user)').length,
  transcript: document.querySelector('#messages')?.innerText ?? ''
}))()`;

let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;

let page: string | undefined;

let panel: string | undefined;

try {
  rp = await launchRealPath();
  const run = rp;
  const blank = await until(async () => (await run.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始页");
  page = await run.attach(blank.targetId);
  const pageSession = page;
  await run.cdp.send("Page.enable", {}, pageSession);
  await run.cdp.send("Page.navigate", { url }, pageSession);
  await until(async () => run.evaluate(pageSession, "!!document.querySelector('#cancel span')").catch(() => false), 15_000, "练习页");
  panel = await run.attach(await run.openSidePanel());
  const panelSession = panel;
  await run.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panelSession);
  await until(async () => {
    const state: Panel = await run.evaluate(panelSession, panelState);

    return state.connected && state.title.includes("点选练习");
  }, 90_000, "真侧栏认出工作页");
  checks.pageIdentity = await run.evaluate(pageSession, `location.href === ${JSON.stringify(url)} && document.title === '点选练习'`);
  checks.meaningfulPage = await run.evaluate(pageSession, "document.querySelector('h1').textContent === '订单操作'");

  const marks = new Map<number, number[]>();

  const readMarks = async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = await run.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, pageSession) as { root: Node };
    const ids: number[] = [];

    const walk = (node: Node) => {
      const a = node.attributes ?? [];
      const i = a.indexOf("class");

      if (i >= 0 && /(^|\s)mark(\s|$)/.test(a[i + 1] ?? "")) ids.push(node.backendNodeId);

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);

    for (const backendNodeId of ids) {
      if (marks.has(backendNodeId)) continue;
      const box = await run.cdp.send("DOM.getBoxModel", { backendNodeId }, pageSession).catch(() => null);

      if (box?.model?.border) marks.set(backendNodeId, box.model.border);
    }
  };

  const ask = async (text: string) => {
    const before: Panel = await run.evaluate(panelSession, panelState);
    await run.click(panelSession, "#input");
    await run.typeText(panelSession, text);
    await run.pressEnter(panelSession);
    // SAFETY: panelState 是本文件写的页面脚本，返回 Panel 形状。
    await until(async () => (await run.evaluate(panelSession, panelState) as Panel).users.some(s => s.includes(text)), 15_000, "用户消息已发出");
    await until(async () => run.evaluate(pageSession, "!!document.querySelector('[data-sideagent-point]')"), 120_000, "模型主动请求用户点选");

    return before;
  };

  const waitDone = async (before: Panel) => {
    let idle = 0;
    await until(async () => {
      await readMarks();
      const state: Panel = await run.evaluate(panelSession, panelState);
      idle = !state.busy && state.replies > before.replies ? idle + 1 : 0;

      return idle >= 6;
    }, 240_000, "模型任务结束", 500);
  };

  const first = await ask("我指一个按钮给你，把我指的那个圈出来，不要点它。");
  checks.pickRequested = true;
  await run.screenshot(pageSession, join(artifacts, "01-picking.png"));
  // 故障注入：网页自己把焦点抢回按钮；点选时按 Enter 仍不得激活网页。
  await run.evaluate(pageSession, "document.querySelector('#save').focus()");
  await run.pressEnter(pageSession);
  checks.keyboardCannotActivateUnderPicker = await run.evaluate(pageSession, "receipts.save.length === 0 && receipts.cancel.length === 0");
  // 注入只负责夹具；选择必须通过可信输入，而不是直接调用产品返回选择结果。
  await run.click(pageSession, "#cancel span");
  await waitDone(first);
  const target = await run.evaluate(pageSession, "(() => {const r=document.querySelector('#cancel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");

  const onTarget = [...marks.values()].filter(q => {
    const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
    const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
    const width = Math.max(q[0]!, q[2]!, q[4]!, q[6]!) - Math.min(q[0]!, q[2]!, q[4]!, q[6]!);
    const height = Math.max(q[1]!, q[3]!, q[5]!, q[7]!) - Math.min(q[1]!, q[3]!, q[5]!, q[7]!);

    return width >= target.width && height >= target.height && Math.abs(x - (target.x + target.width / 2)) < 20 && Math.abs(y - (target.y + target.height / 2)) < 20;
  });

  checks.markOnUserSelectedButton = marks.size > 0 && onTarget.length === marks.size;
  checks.pickClosedAfterSelection = await run.evaluate(pageSession, "!document.querySelector('[data-sideagent-point]')");
  const receipts = await run.evaluate(pageSession, "receipts");
  checks.selectionDidNotActivatePage = receipts.save.length === 0 && receipts.cancel.length === 0;
  evidence.selection = { target, markQuads: [...marks.values()], receipts };
  await run.screenshot(pageSession, join(artifacts, "02-selected-and-marked.png"));

  const marksBeforeCancel = new Set(marks.keys());
  const second = await ask("这次我再指一个按钮给你，请圈出我接下来指的那个，不要点击任何按钮。");
  checks.secondPickRequested = true;
  const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await run.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, pageSession);
  await run.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, pageSession);
  await waitDone(second);
  checks.noNewMarkAfterEscape = [...marks.keys()].every(id => marksBeforeCancel.has(id));
  checks.pickClosedAfterEscape = await run.evaluate(pageSession, "!document.querySelector('[data-sideagent-point]')");
  const end: Panel = await run.evaluate(panelSession, panelState);
  const cancelReply = end.transcript.slice(second.transcript.length);
  checks.cancellationReported = /取消|cancel/i.test(cancelReply);
  evidence.cancelReply = cancelReply;
  evidence.finalReceipts = await run.evaluate(pageSession, "receipts");
  checks.cancellationDidNotActivatePage = await run.evaluate(pageSession, "receipts.save.length === 0 && receipts.cancel.length === 0");
  await run.screenshot(panelSession, join(artifacts, "03-panel.png"));
  await writeFile(join(artifacts, "panel-transcript.txt"), end.transcript);
  // 用户在真实侧栏按停止，不能等待点选的 90 秒超时才交还页面。
  const marksBeforeStop = new Set(marks.keys());
  await ask("再让我指一个元素，等我选择后再圈出来，不要点击网页。");
  checks.stopPickRequested = true;
  await run.click(panelSession, "#send-btn");
  await until(async () => run.evaluate(pageSession, "!document.querySelector('[data-sideagent-point]')"), 10_000, "停止任务撤掉点选层");
  checks.stopRemovesPicker = true;
  let stoppedIdle = 0;
  await until(async () => {
    await readMarks();
    const state: Panel = await run.evaluate(panelSession, panelState);
    stoppedIdle = state.busy ? 0 : stoppedIdle + 1;

    return stoppedIdle >= 6;
  }, 15_000, "停止后没有继续执行", 500);
  checks.noNewMarkAfterStop = [...marks.keys()].every(id => marksBeforeStop.has(id));
  checks.stopDidNotActivatePage = await run.evaluate(pageSession, "receipts.save.length === 0 && receipts.cancel.length === 0");
  evidence.models = await modelReplies(run.dirs.data);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  if (rp) {
    if (panel) {
      await rp.screenshot(panel, join(artifacts, "panel-final.png")).catch(() => {});
      // SAFETY: panelState 返回 Panel；读失败时只用到 transcript 字段。
      await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, panelState).catch(() => ({ transcript: "" })) as Panel).transcript);
    }

    if (page) await rp.screenshot(page, join(artifacts, "page-final.png")).catch(() => {});

    for (const file of (await snapshotDir(rp.dirs.data)).keys()) {
      await mkdir(dirname(join(artifacts, "data", file)), { recursive: true });
      await copyFile(join(rp.dirs.data, file), join(artifacts, "data", file)).catch(() => {});
    }

    await writeFile(join(artifacts, "host.log"), await rp.hostLog());
    const closed = await rp.close();
    checks.hostExitedWithChrome = closed.exitedWithChrome;
    evidence.cleanup = closed;
    await rp.remove();
  }

  await new Promise<void>(done => site.close(() => done()));
}

checks.dailyBuildUnchanged = dailyDistBefore === await sha256File(join(REPO, "extension/dist/background.js"));

const ok = !failure && Object.keys(checks).length >= 13 && Object.values(checks).every(Boolean);

await writeFile(join(artifacts, "result.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ok, failure, checks, evidence }, null, 2));

console.log(JSON.stringify({ ok, failure, checks, artifacts }, null, 2));

process.exitCode = ok ? 0 : 1;
