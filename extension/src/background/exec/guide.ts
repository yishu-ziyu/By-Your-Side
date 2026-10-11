/**
 * guide_step：教一步。圈出目标、光标停在旁边，在这次工具调用里等用户自己点（docs/evals/20261011-guided-teaching.md）。
 * 工具自己从不点击：页面里只听用户的真实点击，结果经 port 报回来。等待方式与发送确认相同（send-confirm.ts）。
 */
import type { GuideStepResult, GuideWait, ToolContract } from "../../../../shared/protocol.js";
import { bringForwardForUser } from "../foreground.js";
import { readCurrentDocument } from "./page-readiness.js";
import type { SendGuard } from "../send-confirm.js";
import { resolveWorkingTab } from "../state.js";
import { notExecuted, showGuide } from "./input.js";

/** 用户多久没点中就结束这一步。宿主放宽的期限比这个长，所以总是这里先给出 timeout。 */
const GUIDE_WAIT_MS = 120_000;

const PORT_PREFIX = "guide-step:";

/** 页面没在这么久内连上后台，就当没画出来。 */
const SHOW_MS = 5_000;

const POLL_MS = 150;

/** 第二次点中仍没变化就交回模型：再等下去用户也只会继续点一个没反应的东西。 */
const NO_CHANGE_LIMIT = 2;

const NOT_CLICKED = "工具没有替用户点任何东西。";

const TEXT = {
  stopped: `用户停下了任务或接管了页面：这一步教学已经结束，圈和光标都收起了。${NOT_CLICKED}不要替用户点，也不要接着教下一步，等用户的新要求。`,
  left: `用户离开或关掉了这个网页：这一步教学已经结束。${NOT_CLICKED}在回复里告诉用户教到了哪一步，需要时可以从这一步重新开始。`,
  no_change: `用户点了两次圈出的目标，页面都没有变化：这一步没完成。${NOT_CLICKED}不要原样重复这一步；先看一下页面，向用户解释可能的原因，或换一个办法。`,
  timeout: `用户 2 分钟内没有点圈出的目标：这一步先放着，圈和光标已收起。${NOT_CLICKED}简短告诉用户你在等，好了说一声就从这一步继续。`,
  busy: "这个网页上已经有一步教学在等用户点：这次没有再圈。等那一步有了结果再继续。",
  program: "网页脚本程序里不能教一步：教学要等用户在网页上自己点，程序等不了。请单独调用 guide_step。",
  notShown: "没能在网页上圈出这一步（页面不让显示），没有开始等待。",
};

/** 正在教的标签页：同一页同时只教一步。 */
const pendingTabs = new Set<number>();

const waitingPorts = new Map<string, { tabId: number; take: (port: chrome.runtime.Port) => void }>();

chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith(PORT_PREFIX)) return;
  const waiting = waitingPorts.get(port.name);

  // 只认这次教学所在标签页的顶层文档。
  if (!waiting || port.sender?.id !== chrome.runtime.id || port.sender.tab?.id !== waiting.tabId || port.sender.frameId !== 0) { port.disconnect(); return; }
  waitingPorts.delete(port.name);
  waiting.take(port);
});

type Params = ToolContract["guide_step"]["params"];

type Ending = { outcome: "done"; changed?: GuideStepResult["changed"]; after?: string } | { outcome: "stopped" | "left" | "no_change" | "timeout" };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function guideStep(params: Params, sessionId: string, guard: SendGuard): Promise<GuideStepResult> {
  if (typeof params.target !== "string" || !params.target.trim()) throw notExecuted(new Error("guide_step 需要 target：要用户点的那个元素。"));

  if (typeof params.say !== "string" || !params.say.trim()) throw notExecuted(new Error("guide_step 需要 say：写在圈旁、告诉用户这一步点什么。"));

  if (!Number.isInteger(params.step) || params.step < 1) throw notExecuted(new Error("guide_step 需要 step：从 1 开始的步数。"));

  if (guard.inProgram) throw notExecuted(new Error(TEXT.program));
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw notExecuted(new Error("工作标签页无效"));
  const tabId = tab.id;

  if (pendingTabs.has(tabId)) throw notExecuted(new Error(TEXT.busy));
  pendingTabs.add(tabId);

  try {
    // 要用户在网页上动手：先把这页切到其窗口内前台（不抢别的窗口）。
    await bringForwardForUser(tabId, "guide");

    return await waitForUser(tabId, params, sessionId, guard);
  } finally { pendingTabs.delete(tabId); }
}

async function waitForUser(tabId: number, params: Params, sessionId: string, guard: SendGuard): Promise<GuideStepResult> {
  const portName = `${PORT_PREFIX}${crypto.randomUUID()}`;
  // 页面可能已经连上、画了圈，之后画的那一步才报错：留着这个 port，出错时断开它，页面才会撤圈、摘监听。
  let taken: chrome.runtime.Port | null = null;
  const connected = new Promise<chrome.runtime.Port>(take => waitingPorts.set(portName, { tabId, take: p => { taken = p; take(p); } }));
  let port: chrome.runtime.Port | null = null;
  let name = "";

  try {
    ({ name } = await showGuide(tabId, params.target, params.say.trim(), portName, sessionId));
    port = await Promise.race([connected, new Promise<null>(done => setTimeout(() => done(null), SHOW_MS))]);
  } catch (error) {
    waitingPorts.delete(portName);
    (taken as chrome.runtime.Port | null)?.disconnect();
    // 只画了圈、断开后就撤掉，网页上没有留下任何改动：确实没执行，不记成结果未知。
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { executionFact: "not_executed" as const });
  }

  waitingPorts.delete(portName);

  if (!port) throw notExecuted(new Error(TEXT.notShown));
  const shown = port;
  let wait: GuideWait = { step: params.step, say: params.say.trim(), state: "waiting", ...(name ? { target: name } : {}) };
  guard.waiting(true, wait);
  let misses = 0;
  let noChangeClicks = 0;
  // 点中以后、用户下一次点错之前：这时换了文档，就是这次点击换的页（慢的网页可能在「没有变化」提示之后才换）。
  let hitPending = false;
  const cleanups: Array<() => void> = [];

  const ending = await new Promise<Ending>(done => {
    shown.onMessage.addListener((message: { kind?: unknown; changed?: unknown; after?: unknown; url?: unknown }) => {
      if (message?.kind === "miss") { misses += 1; hitPending = false; }
      else if (message?.kind === "hit") hitPending = true;
      else if (message?.kind === "no_change") {
        noChangeClicks += 1;

        if (noChangeClicks >= NO_CHANGE_LIMIT) { done({ outcome: "no_change" }); return; }
        wait = { ...wait, state: "no_change" };
        guard.waiting(true, wait);
      } else if (message?.kind === "done") {
        const url = typeof message.url === "string" ? ` · url ${clip(message.url, 200)}` : "";
        done({ outcome: "done", changed: message.changed === "url" ? "url" : "dom", after: typeof message.after === "string" ? clip(message.after, 120) + url : url.slice(3) || undefined });
      }
    });
    const gone = () => {
      if (!hitPending) { done({ outcome: "left" }); return; }
      // 换了文档：目标已经不在了，告诉模型现在是哪一页。
      void chrome.tabs.get(tabId).then(tab => tab.url, () => undefined).then(url => done({ outcome: "done", changed: "document", ...(url ? { after: `new page · url ${clip(url, 200)}` } : {}) }));
    };
    shown.onDisconnect.addListener(gone);
    const removed = (closed: number) => { if (closed === tabId) done({ outcome: "left" }); };
    // 网页自己改网址（pushState、#）不换文档，页面里的监听还在，由页面报变化；只有顶层文档换了才在这里结束。
    const updated = (changed: number, info: { url?: string; status?: string }) => {
      if (changed !== tabId || (info.url === undefined && info.status !== "loading")) return;
      void readCurrentDocument(tabId).then(now => { if (now && now.documentId !== shown.sender?.documentId) gone(); });
    };
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.onUpdated.addListener(updated);
    const poll = setInterval(() => { if (guard.cancelled()) done({ outcome: "stopped" }); }, POLL_MS);
    const timer = setTimeout(() => done({ outcome: "timeout" }), GUIDE_WAIT_MS);
    cleanups.push(() => { chrome.tabs.onRemoved.removeListener(removed); chrome.tabs.onUpdated.removeListener(updated); clearInterval(poll); clearTimeout(timer); });
  });

  for (const cleanup of cleanups) cleanup();
  // 页面在 port 断开时撤圈、松开光标、摘掉监听：每条结束路径都经过这里。
  shown.disconnect();
  guard.waiting(false, wait);

  // 没完成的四种结局都带原因：侧栏不画成失败，宿主也不把它们算进连续出错。
  if (ending.outcome !== "done") throw Object.assign(notExecuted(new Error(TEXT[ending.outcome])), { heldReason: `guide_${ending.outcome}` as const });

  return { outcome: ending.outcome, misses, noChangeClicks, ...(ending.changed ? { changed: ending.changed } : {}), ...(ending.after ? { after: ending.after } : {}) };
}
