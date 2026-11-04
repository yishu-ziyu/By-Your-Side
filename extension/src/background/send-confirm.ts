import { OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM } from "../shared/overlay.js";
import { sendLabelKind } from "../shared/mark-actions.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { bringForwardForUser } from "./foreground.js";
import { SEND_ARM_MS, SEND_CONFIRM_PANEL_PORT } from "../relay.js";
import type { GuideWait, HeldReason, SendConfirmView } from "../../../shared/protocol.js";
import { classifyRequest } from "../../../shared/request-confirm.js";
import { SEND_CONFIRM_MS } from "../../../shared/timeouts.js";
import { isPanelUrl } from "./target-window.js";

const PORT_PREFIX = "send-confirm:";

const SHOW_MS = 5_000;

const POLL_MS = 150;

export interface SendGuard {
  inProgram: boolean;
  task: string | undefined;
  cancelled(): boolean;
  programExpired?(): boolean;
  waiting(on: boolean, guide?: GuideWait, send?: SendConfirmView): void;
}

function sendSentence(host: string, label: string, content?: string, recipient?: string): string {
  const to = recipient ? `发给 ${recipient}，` : "";
  return content ? `把这段 ${[...content.replace(/…$/, "")].length} 字的内容${to}在 ${host} 上` : `点「${label.trim()}」${to}在 ${host} 上`;
}

/** WHY: 网页上读「发给谁」：同一表单/容器里的收件人栏，否则页面的主标题。序列化进页面，必须自包含。 */
export function readRecipientInPage(x: number | null, y: number | null, maxLength = 40, target?: Element | null): string | null {
  const at = target ?? (x === null || y === null ? document.activeElement : document.elementFromPoint(x, y));
  const scope = at?.closest("form,[role=dialog],[role=form],main") ?? document;
  const clip = (t: string | null | undefined) => { const v = (t ?? "").replace(/\s+/g, " ").trim(); return v ? (v.length > maxLength ? v.slice(0, maxLength) + "…" : v) : null; };
  for (const el of scope.querySelectorAll<HTMLInputElement>("input,[contenteditable=true]")) {
    const name = [el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.textContent, el.placeholder].join(" ");
    if (/(^|\s)(to|recipients?|收件人|发给)\b/i.test(name) || /收件人|发给/.test(name)) { const v = clip(el.value ?? el.textContent); if (v) return v; }
  }
  const who = (t: string | null) => t?.replace(/^(?:和|与|跟|同)\s*(.+?)\s*的(?:对话|聊天|私信|会话)$/, "$1").replace(/^(?:chat|conversation)\s+with\s+/i, "") ?? null;
  const name = who(clip(document.querySelector("h1,h2")?.textContent));
  const where = clip(document.title)?.replace(/^(?:和|与|跟|同)\s*(.+?)\s*的(?:对话|聊天|私信|会话)$/, "") || null;
  if (!name) return clip(document.title);
  return where && where !== name && !where.includes(name) ? `${name}（${where}）` : name;
}

export interface SendDetails {
  content?: string;
  recipient?: string;
  binding?: string;
  rect?: { left: number; top: number; width: number; height: number };
  route?: SendConfirmView["route"];
  host?: string;
  kind?: SendConfirmView["kind"];
  query?: string;
  path?: string;
  method?: string;
  body?: string;
}

type Outcome = NonNullable<SendConfirmView["outcome"]>;

const NO_OTHER_WAY = "不要换别的办法发出去：不要按回车，不要点别的按钮，也不要用脚本。";

const TEXT: Record<Exclude<Outcome, "send">, string> = {
  decline: `用户拒绝发送（选了「先不发」）：没有点「发送」，草稿还留在页面上。这一轮之后的发送都会被拦下，不会再问。不要再试，${NO_OTHER_WAY}现在就收尾：告诉用户没有发送，或者问用户要不要发。`,
  stopped: `用户停下了任务或接管了页面：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}`,
  left: `用户离开或关掉了这个网页：没有点「发送」。${NO_OTHER_WAY}在回复里告诉用户没有发送。`,
  timeout: `用户 2 分钟内没有确认：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}在回复里告诉用户还没发送，等用户自己决定。`,
};

const REPEAT_TEXT = `用户这一轮已经拒绝发送（选了「先不发」）：这一轮所有发送都已拦下，不会再问，这次也没有发出去。不要再试任何办法发送（点按钮、回车、提交表单、requestSubmit、脚本都一样会被拦）。现在就收尾：告诉用户没有发送，或者问用户要不要发。`;

const BUSY_TEXT = `这个网页上已经有一个「发送」在等用户确认：这次没有点，也没有再出确认框。等那个确认有了结果再说。${NO_OTHER_WAY}`;


function notSent(message: string, heldReason?: HeldReason): Error {
  return Object.assign(new Error(message), { executionFact: "not_executed" as const }, heldReason ? { heldReason } : {});
}

const declined = new Set<string>();

const pendingTabs = new Set<number>();

const waitingPorts = new Map<string, { tabId: number; take: (port: chrome.runtime.Port) => void }>();

chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith(PORT_PREFIX)) return;
  const waiting = waitingPorts.get(port.name);

  if (!waiting || port.sender?.id !== chrome.runtime.id || port.sender.tab?.id !== waiting.tabId || port.sender.frameId !== 0) { port.disconnect(); return; }
  waitingPorts.delete(port.name);
  waiting.take(port);
});

const panelAnswers = new Map<string, (choice: "send" | "decline") => void>();

const panelPorts = new Set<chrome.runtime.Port>();

const confirmedViews = new WeakMap<SendGuard, SendConfirmView>();
const confirmedChecks = new WeakMap<SendGuard, () => Promise<void>>();

export async function recheckConfirmedSend(guard: SendGuard): Promise<void> {
  const check = () => { if (guard.cancelled()) throw notSent(stoppedText(guard), "stopped"); };
  check();
  await confirmedChecks.get(guard)?.();
  check();
}

function stoppedText(guard: SendGuard): string {
  return guard.programExpired?.() ? `网页程序已超时：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}` : TEXT.stopped;
}

export async function reportSendClick<T extends { sendConfirmed?: true; heldReason?: HeldReason }>(guard: SendGuard, run: Promise<T>): Promise<T> {
  const report = (clicked: NonNullable<SendConfirmView["clicked"]>) => {
    confirmedChecks.delete(guard);
    const view = confirmedViews.get(guard);

    if (!view) return;
    confirmedViews.delete(guard);
    guard.waiting(false, undefined, { ...view, clicked });
  };

  try {
    const result = await run;
    report(result?.sendConfirmed ? "yes" : result?.heldReason === "send_changed" ? "changed" : result?.heldReason === "send_unverified" ? "unverified" : "unknown");

    return result;
  } catch (error) {
    const fact = error as { sendConfirmed?: unknown; executionFact?: unknown; heldReason?: HeldReason };
    report(fact?.sendConfirmed === true ? "yes" : fact?.heldReason === "send_changed" ? "changed" : fact?.heldReason === "send_unverified" ? "unverified" : fact?.executionFact === "not_executed" ? "no" : "unknown");
    throw error;
  }
}

function publishPending(): void {
  const pending = [...panelAnswers.keys()];

  for (const port of panelPorts) port.postMessage({ pending });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== SEND_CONFIRM_PANEL_PORT) return;

  if (port.sender?.id !== chrome.runtime.id || !isPanelUrl(port.sender.url)) { port.disconnect(); return; }
  panelPorts.add(port);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    if (panelPorts.size === 0) for (const answer of [...panelAnswers.values()]) answer("decline");
  });
  port.onMessage.addListener((message: { id?: unknown; choice?: unknown }) => {
    if (typeof message?.id !== "string" || (message.choice !== "send" && message.choice !== "decline")) return;
    panelAnswers.get(message.id)?.(message.choice);
  });
  port.postMessage({ pending: [...panelAnswers.keys()] });
});

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : ""; } catch { return ""; }
}

/** WHY: 在页面 ISOLATED world 里画确认框；序列化进页面，必须自包含。 */
function showSendConfirm(attr: string, kind: string, portName: string, label: string, content: string | null, armMs: number, sentence: string, rect: { left: number; top: number; width: number; height: number } | null): void {
  document.querySelectorAll(`[${attr}="${kind}"]`).forEach(node => node.remove());
  const ring = document.createElement("div");
  ring.setAttribute(attr, kind);
  if (rect) ring.style.cssText = `all:initial;position:fixed;z-index:2147483646;pointer-events:none;left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px;border:3px solid #ff9f0a;border-radius:10px;box-shadow:0 0 0 4px rgba(255,159,10,.25)`;
  void label; void content; void armMs; void sentence;
  const host = document.createElement("div");
  host.setAttribute(attr, kind);
  host.setAttribute("role", "status");
  host.textContent = "等你在侧栏确认";
  const base = "all:initial;display:block;position:fixed;z-index:2147483647;pointer-events:none;padding:4px 10px;border-radius:99px;background:#ff9f0a;color:#1a1a1a;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)";
  host.style.cssText = base + ";visibility:hidden";
  const port = chrome.runtime.connect({ name: portName });
  const close = () => { host.remove(); ring.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.isTrusted && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); port.postMessage({ choice: "decline" }); } };
  window.addEventListener("keydown", onKey, true);
  port.onDisconnect.addListener(close);

  (document.body ?? document.documentElement).appendChild(host);
  if (rect) (document.body ?? document.documentElement).appendChild(ring);
  const w = host.offsetWidth, h = host.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let left = rect ? rect.left : (vw - w) / 2, top = rect ? rect.top + rect.height + 10 : vh - h - 24;
  if (rect && top + h > vh - 8) top = rect.top - h - 10;
  left = Math.max(8, Math.min(left, vw - w - 8));
  top = Math.max(8, Math.min(top, vh - h - 8));
  host.style.cssText = `${base};left:${left}px;top:${top}px`;
}

export async function confirmSendIfNeeded(tabId: number, label: string, guard: SendGuard | undefined, readContent: () => Promise<string | SendDetails | undefined>): Promise<boolean> {
  const kind = sendLabelKind(label);

  if (!guard || !kind) return false;

  if (kind === "send") return confirmSend(tabId, label, guard, readContent);
  const read = await readContent().catch(() => undefined);

  if (!(typeof read === "string" ? read : read?.content)) return false;

  return confirmSend(tabId, label, guard, async () => read);
}

export async function confirmSend(tabId: number, label: string, guard: SendGuard, readContent: () => Promise<string | SendDetails | undefined>): Promise<boolean> {

  const key = guard.task === undefined ? null : guard.task;

  if (key && declined.has(key)) throw notSent(REPEAT_TEXT, "repeat");

  if (pendingTabs.has(tabId)) throw notSent(BUSY_TEXT, "busy");
  pendingTabs.add(tabId);

  try {
    await bringForwardForUser(tabId, "send_confirm");

    const read = await readContent().catch(() => undefined);
    const original = typeof read === "string" ? { content: read } : read ?? {};
    if (original.binding === "unavailable") throw notSent("无法核对发送内容：没有发送。请检查网页后重试。", "send_unverified");
    const approved = await askUser(tabId, guard, key, label, original);
    if (approved && original.binding !== undefined) {
      const recheck = async () => {
        const next = await readContent().catch(() => undefined);
        if (!next || typeof next === "string" || next.binding !== original.binding || next.recipient !== original.recipient) {
          throw notSent("确认期间发送内容、收件人或目标发生变化，或无法重新核对：没有发送。请重新检查后确认。", "send_changed");
        }
      };
      await recheck();
      confirmedChecks.set(guard, recheck);
    }
    return approved;
  } finally { pendingTabs.delete(tabId); }
}

function secretField(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  return words.some((word, i) => /^(?:pass|passwd|password|passcode|pwd|token|secret|otp|cvv|cvc|cvn|pin|auth|authorization|session|sessionid|cookie|credentials?|signature|apikey|accesskey|privatekey|secretkey|cardnumber|cardno|jwt|bearer|csrf|xsrf|nonce)\d*$/.test(word)
    || (word === "key" && /^(?:api|access|private|secret|client|app|signing)$/.test(words[i - 1] ?? ""))
    || (word === "card" && /^(?:number|no|num|nr)$/.test(words[i + 1] ?? "")));
}

const INLINE_SECRET = /(pass(?:word|wd|code)?|pwd|token|secret|authorization|api[_-]?key)\d*["']?\s*[:=]/i;

export function requestSummary(body: string | undefined): string | undefined {
  if (!body?.trim()) return undefined;
  const scrub = (value: unknown, hidden: boolean): unknown => hidden ? "••••"
    : Array.isArray(value) ? value.map(item => scrub(item, false))
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secretField(key))]))
        : typeof value === "string" && INLINE_SECRET.test(value) ? "••••" : value;
  let text: string | undefined;

  try { text = JSON.stringify(scrub(JSON.parse(body), false)); } catch {
    if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body.trim())) text = [...new URLSearchParams(body.trim())].map(([key, value]) => `${key}=${secretField(key) ? "••••" : value}`).join("&");
  }

  return text?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
}

export async function confirmRequest(tabId: number, request: { url: string; body?: string }, guard: SendGuard): Promise<void> {
  const classified = classifyRequest({ method: "POST", url: request.url, body: request.body });
  if (!classified.confirm) return;
  let host = classified.host, path = classified.path || request.url;
  try { const url = new URL(request.url); host = url.host; path = url.pathname; } catch {  }
  const content = requestSummary(request.body);
  await confirmSend(tabId, `${classified.method} ${path}`.slice(0, 60), guard, async () => ({
    ...(content ? { content } : {}),
    ...(host ? { host } : {}),
    route: "request",
    kind: classified.intent === "search" ? "search" : "request",
    path,
    method: classified.method,
    ...(content ? { body: content } : {}),
  }));
}

async function askUser(tabId: number, guard: SendGuard, key: string | null, label: string, details: SendDetails): Promise<boolean> {
  const { content, recipient, rect, route } = details;
  let host = details.host ?? "";
  if (!host) try { host = hostOf((await chrome.tabs.get(tabId)).url); } catch {  }
  const portName = `${PORT_PREFIX}${crypto.randomUUID()}`;
  const connected = new Promise<chrome.runtime.Port>(take => waitingPorts.set(portName, { tabId, take }));
  let port: chrome.runtime.Port | null = null;

  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: showSendConfirm, args: [OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM, portName, label, content ?? null, SEND_ARM_MS, sendSentence(host, label, content, recipient), rect ?? null] });
    port = await Promise.race([connected, new Promise<null>(done => setTimeout(() => done(null), SHOW_MS))]);
  } catch {  }

  waitingPorts.delete(portName);

  if (!port) throw notSent("确认框没能显示在网页上，所以没有点「发送」。先看一眼侧栏，或再打开这个网页后重试。");
  const shown = port;
  const now = Date.now();
  const view: SendConfirmView = {
    id: crypto.randomUUID(),
    host: details.host ?? hostOf(shown.sender?.url),
    label: label.trim(),
    ...(content ? { content } : {}),
    ...(recipient ? { recipient } : {}),
    ...(route ? { route } : {}),
    ...(details.kind ? { kind: details.kind } : {}),
    ...(details.query ? { query: details.query } : {}),
    ...(details.path ? { path: details.path } : {}),
    ...(details.method ? { method: details.method } : {}),
    ...(details.body ? { body: details.body } : {}),
    startedAt: now,
    expiresAt: now + SEND_CONFIRM_MS,
  };
  const cleanups: Array<() => void> = [];

  const outcome = await new Promise<Outcome>(done => {
    panelAnswers.set(view.id, done);
    publishPending();
    guard.waiting(true, undefined, view);
    shown.onMessage.addListener((message: { choice?: unknown }) => {
      if (message?.choice === "send" || message?.choice === "decline") done(message.choice);
    });
    shown.onDisconnect.addListener(() => done("left"));
    const removed = (closed: number) => { if (closed === tabId) done("left"); };
    const updated = (changed: number, info: { url?: string; status?: string }) => {
      if (changed !== tabId || (info.url === undefined && info.status !== "loading")) return;
      void readCurrentDocument(tabId).then(now => { if (now && now.documentId !== shown.sender?.documentId) done("left"); });
    };
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.onUpdated.addListener(updated);
    const poll = setInterval(() => { if (guard.cancelled()) done("stopped"); }, POLL_MS);
    const timer = setTimeout(() => done("timeout"), SEND_CONFIRM_MS);
    cleanups.push(() => { chrome.tabs.onRemoved.removeListener(removed); chrome.tabs.onUpdated.removeListener(updated); clearInterval(poll); clearTimeout(timer); });
  });

  for (const cleanup of cleanups) cleanup();
  panelAnswers.delete(view.id);
  publishPending();
  shown.disconnect();
  const final: Outcome = outcome === "send" && guard.cancelled() ? "stopped" : outcome;
  const { content: _draft, ...withoutDraft } = view;
  guard.waiting(false, undefined, { ...withoutDraft, outcome: final });

  if (final === "send") confirmedViews.set(guard, withoutDraft);

  if (outcome === "send" && final === "stopped") throw notSent(stoppedText(guard), "stopped");

  if (outcome === "send") return true;

  if (outcome === "decline" && key) {
    if (declined.size >= 200) declined.delete(declined.values().next().value!);
    declined.add(key);
  }

  throw notSent(outcome === "stopped" ? stoppedText(guard) : TEXT[outcome], outcome === "decline" ? "declined" : outcome);
}
