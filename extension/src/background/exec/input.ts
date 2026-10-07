import { OVERLAY_ATTR } from "../../shared/overlay.js";
import {assertObservedDocument, assertSameDocument} from "../observation-document.js";
import {replaceEditableText} from "../../shared/editable-text.js";
import { readInputRange } from "../../shared/range-input.js";
import { rangeIssueOf, type InputRangeReadout } from "../../../../shared/page-readout.js";
import { LEAD_SESSION_ID, type PageInteractionMessage, type ToolContract } from "../../../../shared/protocol.js";
import { documentPoint, pointsOnTab } from "../../shared/cursor-trail.js";
import { recordTrailPoint, trailForReplay } from "./trail.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, maybeActivateTab, resolveWorkingTab } from "../state.js";
import { resolveKey, type KeyInfo } from "../../shared/keymap.js";
import { axBackendNodeFor, isAxRef } from "../axstate.js";
import { observedNodeRange, observedNodeRect } from "../observed-node-rect.js";
import { cursorContext } from "../cursor-context.js";
import { oneLine } from "../util.js";
import { resolveImplicitMarkActions } from "../../shared/mark-actions.js";
import { getMarkMotion } from "../mark-motion.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { beginEffect, collectEffect } from "./effect.js";
import { watchDialog, type OpenedDialog } from "../page-events.js";
import { switchTab } from "./tabs.js";
import type { EffectReport } from "../../../../shared/effect.js";
import type { ToolExecutionFact } from "../../../../shared/protocol.js";
import {
  pointInElementRect,
  pressedButtonsMask,
  type ElementPosition,
  type MouseButton,
} from "../../../../shared/pointer-input.js";

/** 派发前的核对：checkNow 同步复查任务身份，noteEffect 记下页面输入已经发出。 */
export type DispatchGuard = (() => Promise<void>) & {checkNow?: () => void; noteEffect?: () => void};

export type { ElementPosition, MouseButton } from "../../../../shared/pointer-input.js";

export { pointInElementRect } from "../../../../shared/pointer-input.js";

type HeldInputState = {
  tabId?: number;
  mouseButtons: Set<MouseButton>;
  keys: Map<string, KeyInfo>;
  pointer: [number, number] | null;
};

const heldInputs = new Map<string, HeldInputState>();

function heldOf(sessionId: string): HeldInputState {
  let state = heldInputs.get(sessionId);

  if (!state) {
    state = { mouseButtons: new Set(), keys: new Map(), pointer: null };
    heldInputs.set(sessionId, state);
  }

  return state;
}

function keyModifierMask(info: KeyInfo): number {
  const bit = info.key === "Shift" ? 8 : info.key === "Control" ? 2 : info.key === "Meta" ? 4 : info.key === "Alt" ? 1 : 0;

  return info.modifiers | bit;
}

function modifierMaskFor(sessionId: string, tabId?: number): number {
  let mask = 0;
  const state = heldOf(sessionId);

  if (tabId !== undefined && state.tabId !== undefined && state.tabId !== tabId && (state.keys.size || state.mouseButtons.size)) {
    throw notExecuted(new Error("先释放原标签页可能按住的输入；不能把按住状态带到其他页面。"));
  }

  for (const info of state.keys.values()) {
    mask |= keyModifierMask(info);
  }

  return mask;
}

function buttonsMaskFor(sessionId: string): number {
  let mask = 0;

  for (const button of heldOf(sessionId).mouseButtons) {
    mask |= pressedButtonsMask(button);
  }

  return mask;
}

export function notExecuted(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const reported = err as Error & { executionFact?: ToolExecutionFact };

  if (reported.executionFact !== "unknown" && reported.executionFact !== "executed") reported.executionFact = "not_executed";

  return err;
}

/** 页面里核对后拒绝填写（不可填、没有这个选项）：页面一点没动，确定没执行。 */
class FillRefused extends Error {
  readonly executionFact = "not_executed" as const;
}

/** debugger 被占用/分离一类的失败：只有这类失败可以改走 domops 页面内路径。 */
function isDebuggerUnavailable(error: unknown): boolean {
  return /占用|DevTools|debugger|detach/i.test(oneLine(error));
}

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CDP/DOM 读回的 rect 未必真带齐字段；按 DomRect 契约在边界校验一次，调用点不再各自 typeof。 */
function isDomRect(value: DomRect | undefined | null): value is DomRect {
  return !!value && typeof value.x === "number";
}

/** tabIds 可能来自消息边界，调用方未必过类型；按 chrome.tabs 的 id 契约（正整数）校验一次。 */
function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Serialized into the page by callDom; keep this function self-contained. */
function readDomTargetRect(target: string): { ok: true; rect: DomRect } | { ok: false; error: string } {
  const dom = window.__sideagent?.dom;

  if (!dom) return { ok: false, error: "domops 未注入" };

  try {
    return { ok: true, rect: dom.rectOf(target) };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** "@N" → ref 号；非 @N 形式返回 null。 */
function parseRef(target: string): number | null {
  if (!target.startsWith("@")) return null;
  const n = Number(target.slice(1));

  return Number.isInteger(n) && n > 0 ? n : null;
}

/** callOnBackendNode 参数里的页面对象：按 objectId 原样传入，不做 JSON 序列化。 */
class CdpObjectArg {
  constructor(readonly objectId: string) {}
}

/** 把 backendDOMNodeId 解析成页面内元素并执行函数（CDP Runtime.callFunctionOn）。 */
export async function callOnBackendNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args?: unknown[],
  executionContextId?: number,
  expectedDocumentId?: string,
  beforeDispatch?: DispatchGuard,
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode",
    executionContextId !== undefined ? { backendNodeId, executionContextId } : { backendNodeId });

  const objectId = resolved.object?.objectId;

  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");

  if(expectedDocumentId) {
    try { await assertSameDocument(tabId,expectedDocumentId); }
    catch(error) { throw notExecuted(error); }
  }

  const result = await sendCommand<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn",
    args
      ? { objectId, functionDeclaration, arguments: args.map((value) => (value instanceof CdpObjectArg ? { objectId: value.objectId } : { value })), returnByValue: true }
      : { objectId, functionDeclaration, returnByValue: true }, beforeDispatch);

  beforeDispatch?.noteEffect?.();
  if (result.exceptionDetails) {
    throw Object.assign(new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败",
    ), {executionFact: "unknown"});
  }

  return result.result?.value as T;
}

/** AX ref → 元素视口包围盒（scrollIntoView + getBoundingClientRect）。 */
async function rectOfBackendNode(tabId: number, backendNodeId: number, contentOnly = false, beforeDispatch?: DispatchGuard, nativeTimeHost = false): Promise<DomRect> {
  const rect = await callOnBackendNode<DomRect | undefined>(
    tabId,
    backendNodeId,
    nativeTimeHost ? `function(contentOnly) {
      const host = this.getRootNode?.()?.host;
      const target = host?.tagName === "INPUT" && host.type === "time" ? host : this;
      return (${observedNodeRect.toString()}).call(target, contentOnly);
    }` : observedNodeRect.toString(),
    [contentOnly], undefined, undefined, beforeDispatch,
  );

  if (!rect) throw new Error("无法获取元素位置");

  return rect;
}

/** 填写回执：浏览器判定越界时带上 rangeIssue（值、问题、允许范围），不报成单纯成功。 */
function filledResult(range: InputRangeReadout | null | undefined): ToolContract["fill"]["data"] {
  const rangeIssue = rangeIssueOf(range);

  return rangeIssue ? { filled: true, rangeIssue } : { filled: true };
}

/** AX ref → 填充（原生 value setter + input/change 事件，与 domops fill 同逻辑）。 */
async function fillBackendNode(tabId: number, backendNodeId: number, value: string, expectedDocumentId?:string, beforeDispatch?: DispatchGuard): Promise<InputRangeReadout | null | undefined> {
  // 先核对目标能不能填、选项在不在，再聚焦写入：核对不过时页面一点没动，回执按「没执行」上报（#22/#27）。
  const outcome = await callOnBackendNode<{ refused: string } | { filled: true; range?: InputRangeReadout | null }>(
    tabId,
    backendNodeId,
    `function(v) {
      let el = this;
      // A native time AX child belongs to the browser's shadow tree. Follow only
      // its exact host, never a nearby input or a matching label.
      const host = el.getRootNode?.()?.host;
      if (host?.tagName === "INPUT" && host.type === "time") el = host;
      const tag = el.tagName.toLowerCase();
      if (tag !== "select" && tag !== "input" && tag !== "textarea" && !el.isContentEditable) {
        return { refused: "元素不可填充（非 input/textarea/select/contenteditable），操作未执行" };
      }
      if (tag === "input" && el.type === "time" && v !== "") {
        const probe = el.ownerDocument.createElement("input");
        probe.type = "time";
        probe.value = v;
        if (probe.value === "") return { refused: "时间格式无效，请使用 HH:mm（如 19:30）；原值保留，操作未执行" };
      }
      if (tag === "select") {
        const wanted = String(v).trim();
        const opts = [...el.options].map((o) => ({ text: o.text, value: o.value }));
        const exact = opts.find((o) => o.text.trim() === wanted || o.value === wanted);
        const match = exact ?? opts.find((o) => o.text.includes(wanted) || (wanted && wanted.includes(o.text.trim())));
        if (!match || !match.text.trim()) return { refused: "下拉框没有这个选项，操作未执行" };
        el.focus();
        el.value = match.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true };
      }
      el.focus();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: true, range: (${readInputRange.toString()})(el) };
      }
      (${replaceEditableText.toString()})(el, v);
      return { filled: true };
    }`,
    [value],
    undefined,
    expectedDocumentId, beforeDispatch,
  );

  // 旧行为不看返回值：拿不到回值（undefined）时照旧当作已填写，只认明确的拒绝。
  if (outcome && "refused" in outcome) throw new FillRefused(outcome.refused);

  return outcome?.range;
}

async function ensureDomOps(tabId: number, beforeDispatch?: DispatchGuard): Promise<void> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-domops.js"],
    world: "ISOLATED",
  });
}

export async function ensureCursor(tabId: number, beforeDispatch?: DispatchGuard): Promise<void> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-cursor.js"],
    world: "ISOLATED",
  });
}

/** 在页面 ISOLATED world 里执行 func 并取回结果。 */
export async function callDom<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
  documentId?:string,
  beforeDispatch?: DispatchGuard,
): Promise<Awaited<Result>> {
  await beforeDispatch?.();
  beforeDispatch?.checkNow?.();
  beforeDispatch?.noteEffect?.();
  const results = await chrome.scripting.executeScript<Args, Result>({
    target: documentId ? { tabId, documentIds: [documentId] } : { tabId },
    world: "ISOLATED",
    func,
    args,
  });

  beforeDispatch?.noteEffect?.();
  const first = results[0];

  if (!first) throw new Error("页面脚本未返回结果");

  return first.result as Awaited<Result>;
}

function cursorId(sessionId: string): string {
  return parseExecutionKey(sessionId).sessionId;
}

async function cursorMove(tabId: number, x: number, y: number, id: string): Promise<void> {
  try {
    await ensureCursor(tabId);

    const ms = await callDom(
      tabId,
      (px: number, py: number, cid: string) => window.__sideagent?.cursor?.for(cid)?.move(px, py) ?? 0,
      [x, y, id],
    );

    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await callDom(tabId, (x: number, y: number, cid: string) => {
      window.__sideagent?.cursor?.for(cid)?.arrive?.(x, y);
    }, [x, y, id]);
  } catch {
    /* 页面禁止注入则跳过可视化 */
  }
}

async function beginCursorAction(
  tabId: number, cid: string, kind: "click" | "fill" | "hover", target?: string, label?: string,
): Promise<string> {
  const actionId = crypto.randomUUID();

  try {
    await ensureCursor(tabId);
    const ref = target ? parseRef(target) : null;

    if (ref !== null && isAxRef(tabId, ref)) {
      const contextId = await cursorContext(tabId);
      await callOnBackendNode(tabId, ref, `function(cid, id, kind, label) {
        const r = this.getBoundingClientRect();
        window.__sideagent?.cursor?.for(cid)?.beginAction(id, kind,
          { x:r.x, y:r.y, width:r.width, height:r.height }, this, label);
      }`, [cid, actionId, kind, label ?? ""], contextId);
    } else {
      if (target) await ensureDomOps(tabId);
      await callDom(tabId, (cid: string, id: string, kind: "click" | "fill" | "hover", target: string | null, label: string) => {
        const anchor = target ? window.__sideagent?.dom?.resolve(target) ?? undefined : undefined;
        const r = anchor?.getBoundingClientRect();
        window.__sideagent?.cursor?.for(cid)?.beginAction(id, kind,
          r ? { x:r.x, y:r.y, width:r.width, height:r.height } : undefined, anchor, label);
      }, [cid, actionId, kind, target ?? null, label ?? ""]);
    }
  } catch {
    // 可视化不可用不改变执行判定；不凭坐标猜另一个元素来画框。
  }

  return actionId;
}

async function endCursorAction(
  tabId: number, cid: string, actionId: string, outcome: "done" | "failed" | "unknown", point?: [number, number],
): Promise<void> {
  try {
    await callDom(tabId, (cid: string, id: string, outcome: "done" | "failed" | "unknown", point: [number, number] | null) => {
      window.__sideagent?.cursor?.for(cid)?.endAction(id, outcome, point ?? undefined);
    }, [cid, actionId, outcome, point ?? null]);
  } catch { /* 导航或退出后的旧动作不能重建提示 */ }
}

async function recordCursorTrail(
  tabId: number,
  sessionId: string,
  vx: number,
  vy: number,
  click: boolean,
): Promise<void> {
  try {
    const scroll = await callDom(tabId, () => ({ x: window.scrollX, y: window.scrollY }), []);
    const doc = documentPoint(vx, vy, scroll.x, scroll.y);
    recordTrailPoint(sessionId, { tabId, x: doc.x, y: doc.y, click });
  } catch {
    recordTrailPoint(sessionId, { tabId, x: Math.round(vx), y: Math.round(vy), click });
  }
}

export async function playLastTrail(
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ steps: number; reason?: string }> {
  const trail = trailForReplay();

  if (!trail) return { steps: 0, reason: "empty" };

  if (trail.sessionId !== sessionId) return { steps: 0, reason: "empty" };
  const pts = pointsOnTab(trail, trail.tabId);

  if (pts.length === 0) return { steps: 0, reason: "empty" };

  try {
    const tab = await chrome.tabs.get(trail.tabId);
    await maybeActivateTab(tab, sessionId);
  } catch {
    return { steps: 0, reason: "tab-gone" };
  }

  await ensureCursor(trail.tabId);
  const cid = cursorId(trail.sessionId);
  await callDom(
    trail.tabId,
    (list: Array<{ x: number; y: number; click: boolean }>, id: string) => {
      window.__sideagent?.cursor?.for(id)?.replay?.(list);
    },
    [pts.map((p) => ({ x: p.x, y: p.y, click: p.click })), cid],
  );

  return { steps: pts.length };
}

export async function stopTrailReplay(sessionId?: string): Promise<void> {
  const trail = trailForReplay();

  if (!trail) return;

  if (sessionId != null && trail.sessionId !== sessionId) return;

  try {
    await callDom(
      trail.tabId,
      (id: string) => {
        window.__sideagent?.cursor?.for(id)?.stopReplay?.();
      },
      [cursorId(trail.sessionId)],
    );
  } catch {
    /* 标签关了 */
  }
}

/** 松开拿住态：摘按住姿态、名牌恢复成员名、照常 park。注入失败静默跳过。 */
async function releaseHold(sessionId: string): Promise<void> {
  const tabId = await resolveOverlayTabId(sessionId);

  if (tabId == null) return;

  try {
    await ensureCursor(tabId);
    await callDom(
      tabId,
      (id: string) => {
        window.__sideagent?.cursor?.for(id)?.releaseHold?.();
      },
      [cursorId(sessionId)],
    );
  } catch {
    /* 页面禁止注入则跳过 */
  }
}

type ClickParams = {
  tabId?: number;
  target?: string;
  point?: [number, number];
  /** 相对 target 左上角的 CSS 像素偏移；有绝对 point 时忽略。 */
  position?: ElementPosition;
  button?: MouseButton;
  clickCount?: number;
  /** 绕过指针拦截/命中核对仍派发（force）。 */
  force?: boolean;
  label?: string;
};

type DragEndpoint = {
  target?: string;
  point?: [number, number];
  position?: ElementPosition;
};

export type DragParams = {
  tabId?: number;
  from: DragEndpoint;
  to: DragEndpoint;
  label?: string;
};

/** 跟随打开的新标签页：url 只在读到时才带上。 */
type OpenedTab = { tabId: number; url?: string };

/** CDP Input.dispatchKeyEvent 参数；commands / text 只在需要时才带上。 */
type KeyEventParams = {
  type: string;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  commands?: string[];
  text?: string;
};

type ClickResult = { clicked: true; effect?: EffectReport; newTab?: { tabId: number; url?: string }; dialog?: OpenedDialog };

async function resolveOverlayTabId(sessionId: string): Promise<number | null> {
  try {
    const claimed = await getWorkingTabId(sessionId);

    if (claimed != null) return claimed;
  } catch {
    /* 没有工作标签 */
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    return active?.id ?? null;
  } catch {
    return null;
  }
}

export async function hideCursors(sessionId: string = LEAD_SESSION_ID): Promise<void> {
  const cid = cursorId(sessionId);
  const tabId = await resolveOverlayTabId(sessionId);

  if (tabId == null) return;

  try {
    await ensureCursor(tabId);
    await callDom(
      tabId,
      (id: string) => {
        window.__sideagent?.cursor?.for(id)?.hide();
        window.__sideagent?.cursor?.hide();
      },
      [cid],
    );
  } catch {
    /* 页面禁止注入则跳过 */
  }
}

export type ControlBannerView = {
  status?: string;
  sub?: string;
  action?: string;
  actionEnabled?: boolean;
  members?: Array<{ id: string; initial: string; color: string }>;
};

// 每页保留各会话的期望状态；最后更新的会话负责当前可见文案。
const controlBannerOwners = new Map<number, Map<string, ControlBannerView | null>>();

const controlBannerRevision = new Map<string, number>();

const controlBannerPaints = new Map<number, Promise<void>>();

const paintedControlBannerOwner = new Map<number, string>();

/** 路由页面上的交还按钮：页面归属和控制条来源可能不是同一会话。 */
export function getControlBannerOwner(tabId: number): string | undefined {
  const owner = paintedControlBannerOwner.get(tabId);

  return owner && controlBannerOwners.get(tabId)?.has(owner) ? owner : undefined;
}

const bannerOwnerKey = (owner?: string) => owner || "default";

function beginBannerShow(owner: string): number {
  const revision = (controlBannerRevision.get(owner) ?? 0) + 1;
  controlBannerRevision.set(owner, revision);

  return revision;
}

/** 同页绘制串行，执行时读取最新期望状态，迟到的旧绘制后必定收敛到新状态。 */
function renderControlBanner(tabId: number): Promise<void> {
  const previous = controlBannerPaints.get(tabId) ?? Promise.resolve();

  const next = previous.then(async () => {
    try {
      await ensureCursor(tabId);
      const owners = controlBannerOwners.get(tabId);
      const show = !!owners?.size;
      const visible = owners ? [...owners.entries()].at(-1) : undefined;
      const view = visible?.[1] ?? null;
      await callDom(tabId, (on: boolean, banner: ControlBannerView | null) => {
        const cursor = window.__sideagent?.cursor;

        if (on) cursor?.showUserControl?.(banner ?? undefined);
        else cursor?.hideUserControl?.();
      }, [show, view]);

      if (visible) paintedControlBannerOwner.set(tabId, visible[0]);
      else paintedControlBannerOwner.delete(tabId);
    } catch { /* 页面关闭或禁止注入，其他页仍继续清理。 */ }
  });

  controlBannerPaints.set(tabId, next);
  void next.finally(() => {
    if (controlBannerPaints.get(tabId) === next) controlBannerPaints.delete(tabId);
  });

  return next;
}

async function showControlBanners(ids: Set<number>, view: ControlBannerView | null | undefined, owner: string, revision: number): Promise<void> {
  // 只读页面查询也会迟到，过期的展示不再登记或绘制。
  if (controlBannerRevision.get(owner) !== revision) return;

  for (const id of ids) {
    const owners = controlBannerOwners.get(id) ?? new Map<string, ControlBannerView | null>();
    owners.delete(owner);
    owners.set(owner, view ?? null);
    controlBannerOwners.set(id, owners);
  }

  await Promise.all([...ids].map(renderControlBanner));
}

export async function showTeamControlBanners(tabIds: Iterable<number>, view?: ControlBannerView | null, owner?: string): Promise<void> {
  const key = bannerOwnerKey(owner);
  const revision = beginBannerShow(key);
  const ids = new Set([...tabIds].filter(isTabId));

  try {
    const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});

    if (active?.id != null) ids.add(active.id);
  } catch { /* 无活动页 */ }

  await showControlBanners(ids, view, key, revision);
}

export async function hideCursorsForSessions(sessionIds: Iterable<string>): Promise<void> {
  await Promise.all([...sessionIds].map(id => hideCursors(id)));
}

/** 清理该会话实际展示过的全部页；其他会话的控制条重新按其状态绘制。 */
export async function hideControlBannersForOwner(owner: string, alsoHide: Iterable<number> = []): Promise<void> {
  const key = bannerOwnerKey(owner);
  beginBannerShow(key);
  const ids = new Set<number>(alsoHide);

  for (const [id, owners] of controlBannerOwners) {
    if (!owners.delete(key)) continue;
    ids.add(id);

    if (!owners.size) controlBannerOwners.delete(id);
  }

  await Promise.all([...ids].map(renderControlBanner));
}

export async function hideUserControlBanners(tabId?: number, owner?: string): Promise<void> {
  if (tabId == null) return hideControlBannersForOwner(bannerOwnerKey(owner));
  // 扩展启动时清理由旧 isolated world 遗留的单页控制条。
  controlBannerOwners.delete(tabId);
  await renderControlBanner(tabId);
}

/** 名牌「取消」：收起标注，松开停在目标上的手。 */
export async function cancelMarkHold(sessionId: string = LEAD_SESSION_ID): Promise<void> {
  try {
    await clearMarks(sessionId);
  } catch {
    /* 没有标注可清 */
  }

  await releaseHold(sessionId);
}

/** 光标名牌上显示的目标名：先取页面上元素自己的名字，读不到再用模型写的 label。 */
async function nameOfClickTarget(tabId: number, params: ClickParams): Promise<string> {
  return (await pageNameOfClickTarget(tabId, params)) || (params.label?.trim() ?? "");
}

async function pageNameOfClickTarget(
  tabId: number,
  params: ClickParams,
): Promise<string> {
  const target = params.target;

  if (!target) return "";
  const ref = parseRef(target);
  const backendNodeId = axBackendNodeFor(tabId, ref);

  const read = `function() {
    const el = this;
    if (el.form && (el.type === "submit" || el.type === "image")) return "提交表单";
    const t = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || el.innerText || el.textContent || "";
    return String(t).trim().replace(/\\s+/g, " ").slice(0, 40);
  }`;

  try {
    if (backendNodeId !== undefined) {
      return (await callOnBackendNode<string>(tabId, backendNodeId, read)) ?? "";
    }

    await ensureDomOps(tabId);

    return await callDom(
      tabId,
      (t: string): string => {
        const el = window.__sideagent?.dom?.resolve(t);

        if (!el) return "";
        if ("form" in el && el.form && "type" in el && (el.type === "submit" || el.type === "image")) return "提交表单";

        const raw =
          (el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText || el.textContent || "") +
          "";

        return raw.trim().replace(/\s+/g, " ").slice(0, 40);
      },
      [target],
    );
  } catch {
    return "";
  }
}

/** 定位目标只读页面、不发任何输入：这里的任何失败都意味着操作没有执行。 */
async function resolvePointerTarget(
  tabId: number,
  params: ClickParams,
  beforeDispatch?: DispatchGuard,
): Promise<{ point: [number, number]; targetRect?: DomRect }> {
  try {
    return await locatePointerTarget(tabId, params, beforeDispatch);
  } catch (error) {
    throw notExecuted(error);
  }
}

async function locatePointerTarget(
  tabId: number,
  params: ClickParams,
  beforeDispatch?: DispatchGuard,
): Promise<{ point: [number, number]; targetRect?: DomRect }> {
  const target = params.target;
  let point = params.point;

  if (!point && !target) throw new Error("需要 target 或 point 参数");

  if (params.position && !target && !point) {
    throw new Error("position 需要配合 target（相对元素左上角 CSS 像素）");
  }

  let targetRect: DomRect | undefined;

  if (target) {
    // target → 元素中心视口坐标与包围盒。@N 若来自 AX 快照（ref 即 backendDOMNodeId）走 CDP；
    // 否则（DOM 回退快照的 ref 或 CSS/loc 形式）或 debugger 被占用时走 domops 页面内解析。
    const ref = parseRef(target);
    const backendNodeId = axBackendNodeFor(tabId, ref);
    let resolvedViaCdp = false;

    if (backendNodeId !== undefined) {
      try {
        targetRect = await rectOfBackendNode(tabId, backendNodeId, false, beforeDispatch);

        if (!isDomRect(targetRect)) throw new Error("无法获取元素位置");

        if (!point) {
          point = pointInElementRect(targetRect, params.position);
        }

        resolvedViaCdp = true;
      } catch (e) {
        if (!isDebuggerUnavailable(e)) {
          if (e && typeof e === "object" && "executionFact" in e) {
            const fact = (e as {executionFact:unknown}).executionFact;
            if (fact === "not_executed") throw e;
            throw Object.assign(new Error(`ref @${ref} 已失效，结果未知。请重新 snapshot，确认当前目标，不要重试旧 ref（${oneLine(e)}）`),{executionFact:fact});
          }
          throw notExecuted(new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`));
        }
        // debugger 不可用：落到 domops 路径（注意此时 @N 依赖 DOM 快照的 refs，
        // 若上次快照是 AX 版会解析不到——属边缘情况，让 domops 报「已失效」即可）
      }
    }

    if (!resolvedViaCdp && !point) {
      await ensureDomOps(tabId, beforeDispatch);

      const res = await callDom(
        tabId,
        readDomTargetRect,
        [target], undefined, beforeDispatch,
      );

      if (!res || !res.ok) {
        throw new Error(res?.ok === false ? res.error : `未找到目标元素：${target}`);
      }

      if (!isDomRect(res.rect)) throw new Error(`未找到目标元素：${target}`);

      targetRect = res.rect;
      point = pointInElementRect(targetRect, params.position);
    }
  }

  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new Error(`无法获取操作坐标：target=${target ?? "none"}`);
  }

  return { point, targetRect };
}

const TARGET_OWNS_HIT_JS = `function ownsUpward(el, hit) {
  if (!el || !hit) return false;
  if (el === hit) return true;
  if (el.contains && el.contains(hit)) return true;
  var n = hit;
  var seen = [];
  while (n) {
    if (n === el) return true;
    if (seen.indexOf(n) >= 0) break;
    seen.push(n);
    var root = n.getRootNode && n.getRootNode();
    if (root && root.host && root.host !== n) { n = root.host; continue; }
    n = n.parentElement;
  }
  return false;
}
function targetOwnsHit(el, top, x, y) {
  if (ownsUpward(el, top)) return true;
  var node = el;
  var seen = [];
  while (node) {
    if (seen.indexOf(node) >= 0) break;
    seen.push(node);
    var root = node.getRootNode && node.getRootNode();
    var host = root && root.host;
    if (host && root && typeof root.elementFromPoint === "function") {
      if (top === host) {
        var inner = root.elementFromPoint(x, y);
        if (!inner || inner === top) return false;
        if (ownsUpward(el, inner)) return true;
        return targetOwnsHit(el, inner, x, y);
      }
      node = host;
      continue;
    }
    node = node.parentElement;
  }
  return false;
}`;

// 快照里的编号可能落在按钮里的文字节点上（BYS-143 弹窗的「Close」）：按包住它的元素来点。
const CONFIRM_CLICK_JS = `function() {
  ${TARGET_OWNS_HIT_JS}
  const el = this && this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.isConnected) throw new Error("ref 已失效，操作未执行。请重新 snapshot，在当前页面确认目标并使用新的 ref；不要继续重试旧 ref。");
  if (typeof el.scrollIntoViewIfNeeded === "function") el.scrollIntoViewIfNeeded({ block: "center", inline: "center" });
  else el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!top) throw new Error("目标处没有可命中的元素，操作未执行。请重新 snapshot 确认当前目标。");
  if (!targetOwnsHit(el, top, x, y)) {
    throw new Error("目标被其他元素覆盖，操作未执行。请重新 snapshot 确认当前可点击目标，不要点击原坐标处的其他对象。");
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`;

const HIT_TEST_AT_JS = `function(x, y) {
  ${TARGET_OWNS_HIT_JS}
  const el = this && this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.isConnected) throw new Error("ref 已失效，操作未执行。请重新 snapshot，在当前页面确认目标并使用新的 ref；不要继续重试旧 ref。");
  const top = document.elementFromPoint(x, y);
  if (!top) throw new Error("目标处没有可命中的元素，操作未执行。请重新 snapshot 确认当前目标。");
  if (!targetOwnsHit(el, top, x, y)) {
    throw new Error("目标被其他元素覆盖，操作未执行。请重新 snapshot 确认当前可点击目标，不要点击原坐标处的其他对象。");
  }
  return true;
}`;

function isPrePressTargetError(e: unknown): boolean {
  return /覆盖|已失效|可命中|不可见|不稳定|未找到目标|视口|坐标|替换/.test(oneLine(e));
}

/**
 * 视觉等待后再次确认同一目标仍存在且可命中；失败则停，不点原坐标处的其他对象。
 * 确认阶段还没向页面派发任何输入：任何失败（被覆盖、已失效、找不到）都是「没执行」。
 */
async function confirmPointerTarget(
  tabId: number,
  target: string,
  beforeDispatch?: DispatchGuard,
): Promise<{ point: [number, number]; targetRect: DomRect }> {
  try {
    return await checkPointerTarget(tabId, target, beforeDispatch);
  } catch (error) {
    throw notExecuted(error);
  }
}

async function checkPointerTarget(
  tabId: number,
  target: string,
  beforeDispatch?: DispatchGuard,
): Promise<{ point: [number, number]; targetRect: DomRect }> {
  const ref = parseRef(target);
  const backendNodeId = axBackendNodeFor(tabId, ref);

  if (backendNodeId !== undefined) {
    try {
      const rect = await callOnBackendNode<DomRect | undefined>(tabId, backendNodeId, CONFIRM_CLICK_JS, undefined, undefined, undefined, beforeDispatch);

      if (!rect || typeof rect.x !== "number") throw new Error("无法确认目标位置");

      return {
        targetRect: rect,
        point: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)],
      };
    } catch (e) {
      if (!isDebuggerUnavailable(e)) {
        // 只读的目标核对自己抛出的「被挡、失效、不可见」：页面没动，确定没执行（页面脚本报错默认记成结果不确定）。
        if (/已失效|覆盖|可命中|不可见/.test(oneLine(e))) throw notExecuted(new Error(oneLine(e)));

        if (e && typeof e === "object" && "executionFact" in e) throw e;
        const msg = oneLine(e);
        throw notExecuted(new Error(
          `ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${msg}）`,
        ));
      }
    }
  }

  await ensureDomOps(tabId, beforeDispatch);

  const res = await callDom(
    tabId,
    (t: string): { ok: true; rect: DomRect } | { ok: false; error: string } => {
      const dom = window.__sideagent?.dom;

      if (!dom) return { ok: false, error: "domops 未注入" };

      try {
        return { ok: true, rect: dom.confirmForClick(t) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        return { ok: false, error: message };
      }
    },
    [target], undefined, beforeDispatch,
  );

  if (!res || !res.ok) {
    throw new Error(res?.ok === false ? res.error : `未找到目标元素：${target}`);
  }

  if (!res.rect || typeof res.rect.x !== "number") {
    throw new Error(`未找到目标元素：${target}`);
  }

  return {
    targetRect: res.rect,
    point: [Math.round(res.rect.x + res.rect.width / 2), Math.round(res.rect.y + res.rect.height / 2)],
  };
}

/** 在即将按下的坐标确认仍是同一目标。不滚动，避免把命中检查做成另一次布局扰动。 */
async function hitTestPointerTarget(tabId: number, target: string, x: number, y: number): Promise<void> {
  const ref = parseRef(target);
  const backendNodeId = axBackendNodeFor(tabId, ref);

  if (backendNodeId !== undefined) {
    try {
      await callOnBackendNode<boolean>(tabId, backendNodeId, HIT_TEST_AT_JS, [x, y]);

      return;
    } catch (e) {
      if (!isDebuggerUnavailable(e)) {
        // 只读的目标核对自己抛出的「被挡、失效、不可见」：页面没动，确定没执行（页面脚本报错默认记成结果不确定）。
        if (/已失效|覆盖|可命中|不可见/.test(oneLine(e))) throw notExecuted(new Error(oneLine(e)));

        if (e && typeof e === "object" && "executionFact" in e) throw e;
        const msg = oneLine(e);
        throw notExecuted(new Error(
          `ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${msg}）`,
        ));
      }
    }
  }

  await ensureDomOps(tabId);

  const res = await callDom(
    tabId,
    (t: string, px: number, py: number): { ok: true } | { ok: false; error: string } => {
      const dom = window.__sideagent?.dom;

      if (!dom) return { ok: false, error: "domops 未注入" };

      try {
        dom.hitTestAt(t, px, py);

        return { ok: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        return { ok: false, error: message };
      }
    },
    [target, x, y],
  );

  if (!res || !res.ok) {
    throw new Error(res?.ok === false ? res.error : `未找到目标元素：${target}`);
  }
}

/**
 * 点开新标签页时跟随：`target="_blank"` / `window.open` 会把结果放在隔壁——
 * 不跟的话 agent 会对着「什么都没变」的原页反复重试。归属校验失败（被别人占）只报告不跟随。
 */
async function followOpenedTab(before: ReadonlySet<number>, targetTabId: number, sessionId: string): Promise<{ tabId: number; url?: string } | undefined> {
  try {
    const tabs = await chrome.tabs.query({});

    const opened = tabs.find((tab) => tab.id !== undefined && tab.id !== targetTabId && !before.has(tab.id)
      && (tab.openerTabId === undefined || tab.openerTabId === targetTabId)
      && tab.id > (before.size ? Math.max(...before) : 0));

    if (opened?.id === undefined) return undefined;

    try {
      await switchTab({ tabId: opened.id }, sessionId);
    } catch {
      /* 新页归别人/坐不上就只报告，不抢 */
    }

    const openedTab: OpenedTab = { tabId: opened.id };

    if (opened.url) openedTab.url = opened.url;

    return openedTab;
  } catch {
    return undefined;
  }
}

/**
 * 助手不能点我们自己画在页面上的界面（名牌上的「确认 / 提交」、控制条等）：那些是留给用户的。
 * 09-27 Kimi 实测去点名牌上自己起名为「提交订阅」的确认键：若没被别的检查挡住，就等于自己批准自己。
 * 看真正派发的落点：按编号、选择器、坐标点都一样。用户确认后由扩展重放的那一下不经过这里。
 */
async function assertNotOwnOverlay(tabId: number, x: number, y: number): Promise<void> {
  const hit = await callDom(
    tabId,
    (px: number, py: number, attr: string): boolean => !!document.elementFromPoint(px, py)?.closest(`[${attr}]`),
    [x, y, OVERLAY_ATTR],
  ).catch(() => false);

  if (hit === true) throw notExecuted(new Error("这里是助手自己在页面上画的确认按钮或状态条，只能由用户来点，操作未执行。请在回复里请用户确认，不要点它。"));
}

async function callPointGuard(
  tabId: number,
  x: number,
  y: number,
  kind: "remember" | "confirm",
): Promise<void> {
  await ensureDomOps(tabId);

  const res = await callDom(
    tabId,
    (px: number, py: number, mode: "remember" | "confirm"): { ok: true } | { ok: false; error: string } => {
      const dom = window.__sideagent?.dom;

      if (!dom) return { ok: false, error: "domops 未注入" };

      try {
        if (mode === "remember") dom.rememberPoint(px, py);
        else dom.confirmPoint(px, py);

        return { ok: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        return { ok: false, error: message };
      }
    },
    [x, y, kind],
  );

  if (!res || !res.ok) {
    throw new Error(res?.ok === false ? res.error : "无法确认该坐标操作");
  }
}

/** 只派发真实鼠标移动；虚拟光标不是页面的 CSS :hover 状态。 */
export async function hover(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ hovered: true }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId, [params.target]);
  const { point: [x, y] } = await resolvePointerTarget(tab.id, params, beforeDispatch);
  await maybeActivateTab(tab, sessionId, beforeDispatch);
  const cid = cursorId(sessionId);
  const actionId = beforeDispatch ? "" : await beginCursorAction(tab.id, cid, "hover", params.target, params.label);

  try {
    if (!beforeDispatch) await cursorMove(tab.id, x, y, cid);
    if (beforeDispatch) await sendCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, beforeDispatch);
    else await sendCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await endCursorAction(tab.id, cid, actionId, "done");
  } catch (error) {
    await endCursorAction(tab.id, cid, actionId, "failed");
    throw error;
  }

  if (!beforeDispatch) await recordCursorTrail(tab.id, sessionId, x, y, false);

  return { hovered: true };
}

export async function click(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<ClickResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId, [params.target]);
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  const target = params.target;

  // 点开新页检测用：记下点击前的标签集合（拿不到就跳过跟随，不影响点击）。
  const tabsBefore = new Set<number>(await (async () => {
    try {
      const tabs = await chrome.tabs.query({});

      return tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
    } catch {
      return [];
    }
  })());

  const { point } = await resolvePointerTarget(tabId, params, beforeDispatch);

  if (point) await assertNotOwnOverlay(tabId, point[0], point[1]);

  const name = await nameOfClickTarget(tabId, params);

  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId, beforeDispatch);

  let [x, y] = point!;

  if (!target) {
    await callPointGuard(tabId, x, y, "remember");
  }

  const button: MouseButton = params.button ?? "left";
  const clickCount = Math.max(1, Math.floor(params.clickCount ?? 1));
  const force = params.force === true;
  const modifiers = modifierMaskFor(sessionId, tab.id);

  const actionId = beforeDispatch ? "" : await beginCursorAction(tabId, cid, "click", target, name);

  try {
    // 目标边框与浅弧移动并行；不再为高亮和预播放波纹额外等待。
    if (!beforeDispatch) await cursorMove(tabId, x, y, cid);

    if (target && !force) {
      const confirmed = await confirmPointerTarget(tabId, target, beforeDispatch);

      if (params.position) {
        [x, y] = pointInElementRect(confirmed.targetRect, params.position);
      } else {
        x = confirmed.point[0];
        y = confirmed.point[1];
      }

      if (x !== point[0] || y !== point[1]) {
        if (!beforeDispatch) await cursorMove(tabId, x, y, cid);
      }
    }

    let cdpMouseMoved = false;
    let cdpMousePressed = false;
    let effect: EffectReport | undefined;

    try {
      await beforeDispatch?.();
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers },beforeDispatch);
      cdpMouseMoved = true;
      heldOf(sessionId).pointer = [x, y];
      // 基线与命中核对并行：60ms 的页面活跃度采样不额外压在一次点击的串行等待上。
      const effectPending = beginEffect(tabId, { point: [x, y] });

      // 真实 mouseMoved 可能触发 mouseenter 把目标移走、原位露出 trap。
      // 按下前只核对当前命中与原目标身份；变化则拒绝，不追逐新坐标。
      if (!force) {
        if (target) {
          await hitTestPointerTarget(tabId, target, x, y);
        } else {
          await callPointGuard(tabId, x, y, "confirm");
        }
      }

      const effectToken = await effectPending;
      // 点击弹出原生 alert/confirm/prompt 时页面被对话框挡住，松开鼠标与效果采样要等对话框关掉才返回（#23 等满 30 秒）。
      // 一弹出就按「已点击，页面弹出对话框」返回；还没返回的命令留在后台，对话框关掉后自然结束。
      const dialogWatch = watchDialog(tabId);

      const pressing = (async () => {
        for (let n = 1; n <= clickCount; n++) {
          await beforeDispatch?.();
          await sendCommand(tabId, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button,
            buttons: pressedButtonsMask(button) | buttonsMaskFor(sessionId),
            clickCount: n,
            modifiers,
          },beforeDispatch);
          cdpMousePressed = true;
          await sendCommand(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: buttonsMaskFor(sessionId),
            clickCount: n,
            modifiers,
          });
        }

        return await collectEffect(tabId, effectToken);
      })();

      try {
        const settled = await Promise.race([
          pressing.then(report => ({ effect: report })),
          dialogWatch.opened.then(opened => ({ dialog: opened })),
        ]);

        if ("dialog" in settled) {
          pressing.catch(() => {});
          void endCursorAction(tabId, cid, actionId, "done", [x, y]);

          return { clicked: true, dialog: settled.dialog };
        }

        effect = settled.effect;
      } finally {
        dialogWatch.stop();
      }
    } catch (e) {
      if (e && typeof e === "object" && "executionFact" in e && e.executionFact === "not_executed") {
        // 鼠标移过去后才发现目标被挡、失效：没有按下，点击确定没发生，仍算没执行，允许重新确认后再点。
        if (cdpMouseMoved && !isPrePressTargetError(e)) Object.assign(e,{executionFact:"unknown"});
        throw e;
      }
      if (cdpMousePressed) {
        throw new Error(
          `点击可能已送达，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }

      // SAFETY: guard failures are Errors marked before any mouse press; only inspect their execution fact.
      if (e instanceof FillRefused || (e as { executionFact?: string })?.executionFact === "not_executed") throw e;

      if (cdpMouseMoved) {
        if (isPrePressTargetError(e)) throw notExecuted(e);
        throw new Error(
          `点击是否送达无法确认，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }

      // 尚未向页面派发任何 CDP 输入（如 DevTools 占用）时，才允许 DOM 回退一次
      // 右键/中键/非左键不提供 DOM 回退（document 无法等价 contextmenu/中键）。
      if (target && button === "left" && clickCount === 1 && !force) {
        await ensureDomOps(tabId, beforeDispatch);
        let fallbackEffect: EffectReport | undefined;
        const fallbackToken = await beginEffect(tabId, { point: [x, y] });
        // 与 CDP 点击同理：DOM click 弹出原生对话框会挡住页面，callDom 要等对话框关掉才返回。
        const fallbackWatch = watchDialog(tabId);

        try {
          await beforeDispatch?.();

          const fallbackClick = (async () => {
            await callDom(
              tabId,
              (t: string) => {
                const dom = window.__sideagent?.dom;

                if (!dom) throw new Error("domops 未注入");

                return dom.click(t);
              },
              [target], undefined, beforeDispatch,
            );

            return await collectEffect(tabId, fallbackToken);
          })();

          const fallbackSettled = await Promise.race([
            fallbackClick.then(report => ({ effect: report })),
            fallbackWatch.opened.then(opened => ({ dialog: opened })),
          ]);

          if ("dialog" in fallbackSettled) {
            fallbackClick.catch(() => {});
            void endCursorAction(tabId, cid, actionId, "done", [x, y]);

            return { clicked: true, dialog: fallbackSettled.dialog };
          }

          fallbackEffect = fallbackSettled.effect;
        } finally {
          fallbackWatch.stop();
        }

        const clicked: Extract<ClickResult, { clicked: true }> = { clicked: true };

        if (fallbackEffect) clicked.effect = fallbackEffect;

        return clicked;
      }

      throw e;
    }

    await endCursorAction(tabId, cid, actionId, "done", [x, y]);
    await recordCursorTrail(tabId, sessionId, x, y, true);
    const newTab = tabsBefore.size ? await followOpenedTab(tabsBefore, tabId, sessionId) : undefined;

    const clicked: Extract<ClickResult, { clicked: true }> = { clicked: true };

    if (effect) clicked.effect = effect;

    if (newTab) clicked.newTab = newTab;

    return clicked;
  } catch (error) {
    const unknown = /可能已送达|是否送达无法确认/.test(oneLine(error));
    await endCursorAction(tabId, cid, actionId, unknown ? "unknown" : "failed");
    throw error;
  }
}

type DoubleClickResult =
  | { doubleClicked: true; effect?: EffectReport; newTab?: { tabId: number; url?: string }; dialog?: OpenedDialog }
  | { doubleClicked: false; dialog: OpenedDialog };

/**
 * 真实双击：与 click 同一解析/确认/命中核对/effect 管线，CDP clickCount 1→2。
 * 不提供 DOM dispatchEvent 伪造回退——伪造双击不算双击能力（Issue §五）。
 */
export async function doubleClick(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<DoubleClickResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId, [params.target]);
  const tabId = tab.id;
  const cid = cursorId(sessionId);

  const tabsBefore = new Set<number>(await (async () => {
    try {
      const tabs = await chrome.tabs.query({});

      return tabs.map(t => t.id).filter((id): id is number => id !== undefined);
    } catch {
      return [];
    }
  })());

  const { point } = await resolvePointerTarget(tabId, params, beforeDispatch);

  if (point) await assertNotOwnOverlay(tabId, point[0], point[1]);
  const name = await nameOfClickTarget(tabId, params);

  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId);

  let [x, y] = point!;

  if (!params.target) {
    await callPointGuard(tabId, x, y, "remember");
  }

  const button: MouseButton = params.button ?? "left";
  const force = params.force === true;
  const modifiers = modifierMaskFor(sessionId, tab.id);
  const actionId = beforeDispatch ? "" : await beginCursorAction(tabId, cid, "click", params.target, name);

  try {
    if (!beforeDispatch) await cursorMove(tabId, x, y, cid);

    if (params.target && !force) {
      const confirmed = await confirmPointerTarget(tabId, params.target, beforeDispatch);

      if (params.position) {
        [x, y] = pointInElementRect(confirmed.targetRect, params.position);
      } else {
        x = confirmed.point[0];
        y = confirmed.point[1];
      }

      if (x !== point![0] || y !== point![1]) {
        if (!beforeDispatch) await cursorMove(tabId, x, y, cid);
      }
    }

    let dispatched = false;
    let pressed = false;
    let effect: EffectReport | undefined;

    try {
      await beforeDispatch?.();
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers },beforeDispatch);
      dispatched = true;
      heldOf(sessionId).pointer = [x, y];
      const effectPending = beginEffect(tabId, { point: [x, y] });

      if (!force) {
        if (params.target) {
          await hitTestPointerTarget(tabId, params.target, x, y);
        } else {
          await callPointGuard(tabId, x, y, "confirm");
        }
      }

      const effectToken = await effectPending;
      const btnMask = pressedButtonsMask(button);
      await beforeDispatch?.();
      const dialogWatch = watchDialog(tabId);
      let interrupted = false;
      let nativeInputs = 0;

      const checkSequence = () => {
        if (interrupted) throw new FillRefused("原生弹窗中断了输入序列，剩余输入未派发。");
        beforeDispatch?.checkNow?.();
      };

      const sequenceGuard = Object.assign(async () => {
        checkSequence();
        await beforeDispatch?.();
        checkSequence();
      }, {checkNow:checkSequence,noteEffect:() => {
        nativeInputs++;
        const held = heldOf(sessionId);
        held.tabId = tabId;

        if (nativeInputs % 2) held.mouseButtons.add(button);
        else held.mouseButtons.delete(button);
        beforeDispatch?.noteEffect?.();
      }});

      const opened = dialogWatch.opened.then(dialog => {
        interrupted = true;

        return { dialog };
      });

      const pressing = (async () => {
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button, buttons: btnMask | buttonsMaskFor(sessionId), clickCount: 1, modifiers,
        },sequenceGuard);
        pressed = true;
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button, buttons: buttonsMaskFor(sessionId) & ~btnMask, clickCount: 1, modifiers,
        },sequenceGuard);

        if (interrupted) return undefined;
        await beforeDispatch?.();
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button, buttons: btnMask | buttonsMaskFor(sessionId), clickCount: 2, modifiers,
        },sequenceGuard);
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button, buttons: buttonsMaskFor(sessionId) & ~btnMask, clickCount: 2, modifiers,
        },sequenceGuard);

        return await collectEffect(tabId, effectToken);
      })();

      try {
        const settled = await Promise.race([pressing.then(effect => ({ effect })), opened]);

        if ("dialog" in settled) {
          pressing.catch(() => {});

          return nativeInputs === 4 ? { doubleClicked: true, dialog: settled.dialog } : { doubleClicked: false, dialog: settled.dialog };
        }

        effect = settled.effect;
      } finally {
        dialogWatch.stop();
      }
    } catch (e) {
      if (pressed) {
        throw new Error(`双击可能已送达，后续 CDP 返回异常，未再次双击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`);
      }

      // SAFETY: guard failures are Errors marked before any mouse press; only inspect their execution fact.
      if (e instanceof FillRefused || (e as { executionFact?: string })?.executionFact === "not_executed") throw e;

      if (dispatched) {
        if (isPrePressTargetError(e)) throw notExecuted(e);
        throw new Error(`双击是否送达无法确认，后续 CDP 返回异常，未再次双击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`);
      }

      // 尚未向页面派发任何 CDP 输入：按未执行上报；不允许 DOM dispatchEvent 伪造双击。
      if (isPrePressTargetError(e)) throw notExecuted(e);
      throw notExecuted(new Error(`双击未执行（${oneLine(e)}）。本工具不提供 DOM 伪造回退；请 snapshot 核验目标与调试器状态后重试。`));
    }

    await endCursorAction(tabId, cid, actionId, "done", [x, y]);
    await recordCursorTrail(tabId, sessionId, x, y, true);
    const newTab = tabsBefore.size ? await followOpenedTab(tabsBefore, tabId, sessionId) : undefined;

    const doubleClicked: Extract<DoubleClickResult, { doubleClicked: true }> = { doubleClicked: true };

    if (effect) doubleClicked.effect = effect;

    if (newTab) doubleClicked.newTab = newTab;

    return doubleClicked;
  } catch (error) {
    const unknown = /可能已送达|是否送达无法确认/.test(oneLine(error));
    await endCursorAction(tabId, cid, actionId, unknown ? "unknown" : "failed");
    throw error;
  }
}


/**
 * 按记忆填的那一格标「记得的」（YIS-87）：先给元素挂一个一次性记号属性，再让页面脚本找到它、画记号并摘掉属性。
 * 只是画在页面上面，不改这一格的值；画不出来不影响填写结果。
 */
async function markMemoryField(tabId: number, memory: NonNullable<ToolContract["fill"]["params"]["memory"]>, backendNodeId: number | undefined, target: string): Promise<void> {
  const token = crypto.randomUUID();

  try {
    if (backendNodeId !== undefined) await callOnBackendNode(tabId, backendNodeId, "function(t){ this.setAttribute('data-sideagent-memory-field', t); }", [token]);
    else await callDom(tabId, (t: string, k: string) => { window.__sideagent?.dom?.resolve(t)?.setAttribute("data-sideagent-memory-field", k); }, [target, token]);
    const message: PageInteractionMessage = { type: "MEMORY_FIELD_MARK", token, memory };
    await chrome.tabs.sendMessage(tabId, message);
  } catch { /* 记号只是提示：页面变了或脚本不在就不画。 */ }
}

export async function fill(
  params: { target: string; value: string; tabId?: number; expectedDocumentId?:string; expectedBackendNodeId?:number; memory?: ToolContract["fill"]["params"]["memory"] },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<ToolContract["fill"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  if(params.expectedDocumentId) {
    try { await assertSameDocument(tab.id,params.expectedDocumentId); }
    catch(error) { throw notExecuted(error); }
  }

  await assertObservedDocument(tab.id, sessionId, [params.target]);
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId, beforeDispatch);

  // AX 快照的 @N（ref 即 backendDOMNodeId）走 CDP（同 domops fill 逻辑）；其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = axBackendNodeFor(tabId, ref);

  if(params.expectedBackendNodeId!==undefined && backendNodeId!==params.expectedBackendNodeId) {
    throw notExecuted(new Error('原 AX 对象身份无法核对，填写未执行。'));
  }

  // 操作前在 scrollIntoView 之后取目标包围盒，动作边框持续到操作返回。
  let targetRect: DomRect | undefined;

  if (backendNodeId !== undefined) {
    try {
      targetRect = await rectOfBackendNode(tabId, backendNodeId, false, beforeDispatch, true);
    } catch (e) {
      if (params.expectedBackendNodeId!==undefined || !isDebuggerUnavailable(e)) {
        throw new Error(`ref @${ref} 填充失败（${oneLine(e)}）`);
      }
      // debugger 不可用时落到 domops
    }
  }

  if (!targetRect) {
    try {
      await ensureDomOps(tabId, beforeDispatch);

      const res = await callDom(
        tabId,
        readDomTargetRect,
        [params.target], undefined, beforeDispatch,
      );

      if (res?.ok && res.rect && typeof res.rect.x === "number") {
        targetRect = res.rect;
      } else if (backendNodeId === undefined) {
        throw notExecuted(new Error(res?.ok === false ? res.error : `未找到目标元素：${params.target}`));
      }
    } catch (e) {
      if (backendNodeId === undefined) {
        throw notExecuted(e);
      }
    }
  }

  const actionId = beforeDispatch ? "" : await beginCursorAction(tabId, cid, "fill", params.target);

  try {
    if (targetRect) {
      if (!beforeDispatch) await cursorMove(tabId, Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2), cid);
    }

    // 2. 真实填充操作
    if(params.expectedDocumentId) {
      try { await assertSameDocument(tabId,params.expectedDocumentId); }
      catch(error) { throw notExecuted(error); }
    }

    if (backendNodeId !== undefined) {
      try {
        await beforeDispatch?.();
        const range = await fillBackendNode(tabId, backendNodeId, params.value, params.expectedDocumentId, beforeDispatch);

        if (targetRect) {
          await recordCursorTrail(
            tabId,
            sessionId,
            Math.round(targetRect.x + targetRect.width / 2),
            Math.round(targetRect.y + targetRect.height / 2),
            false,
          );
        }

        await endCursorAction(tabId, cid, actionId, "done");

        if (params.memory) await markMemoryField(tabId, params.memory, backendNodeId, params.target);

        return filledResult(range);
      } catch (e) {
        if (params.expectedBackendNodeId!==undefined || !isDebuggerUnavailable(e)) {
          const reason = `ref @${ref} 填充失败（${oneLine(e)}）`;

          // 页面里核对不过（不可填、没这个选项）时什么都没写：保留「没执行」，不记成结果不确定。
          throw e instanceof FillRefused ? new FillRefused(reason) : new Error(reason);
        }
        // debugger 不可用时落到 domops（其 refs 若无此 ref 会报「已失效」）
      }
    }

    await ensureDomOps(tabId, beforeDispatch);

    await beforeDispatch?.();
    const filled = await callDom(
      tabId,
      (t: string, v: string) => {
        const dom = window.__sideagent?.dom;

        if (!dom) throw new Error("domops 未注入");

        const el = dom.resolve(t);

        // SAFETY: dom.resolve returns an Element; its INPUT tag identifies the native input contract.
        if (el?.tagName === "INPUT" && (el as HTMLInputElement).type === "time" && v !== "") {
          const probe = el.ownerDocument.createElement("input");
          probe.type = "time";
          probe.value = v;

          if (probe.value === "") return { refused: "时间格式无效，请使用 HH:mm（如 19:30）；原值保留，操作未执行" };
        }

        return dom.fill(t, v);
      },
      [params.target, params.value],
      params.expectedDocumentId, beforeDispatch,
    );

    if (filled && "refused" in filled) throw new FillRefused(filled.refused);

    if (targetRect) {
      await recordCursorTrail(
        tabId,
        sessionId,
        Math.round(targetRect.x + targetRect.width / 2),
        Math.round(targetRect.y + targetRect.height / 2),
        false,
      );
    }

    await endCursorAction(tabId, cid, actionId, "done");

    if (params.memory) await markMemoryField(tabId, params.memory, undefined, params.target);

    return filledResult(filled?.range);
  } catch (error) {
    await endCursorAction(tabId, cid, actionId, error instanceof FillRefused ? "failed" : "unknown");
    throw error;
  }
}

export type SelectOptionValue =
  | string
  | { value?: string; label?: string; index?: number }
  | null;

/** CAP-02C：原生 select 的 value/label/index、多选、清空；返回最终选中集合与可见 label。 */
export async function selectOption(
  params: {
    target: string;
    values: SelectOptionValue | SelectOptionValue[];
    tabId?: number;
    expectedDocumentId?: string;
    expectedBackendNodeId?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ selected: string[]; labels: string[] }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  if (params.expectedDocumentId) {
    try {
      await assertSameDocument(tab.id, params.expectedDocumentId);
    } catch (error) {
      throw notExecuted(error);
    }
  }

  await assertObservedDocument(tab.id, sessionId, [params.target]);
  const tabId = tab.id;
  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId, beforeDispatch);

  const ref = parseRef(params.target);
  const backendNodeId = axBackendNodeFor(tabId, ref);

  if (params.expectedBackendNodeId !== undefined && backendNodeId !== params.expectedBackendNodeId) {
    throw notExecuted(new Error("原 AX 对象身份无法核对，选择未执行。"));
  }

  if (backendNodeId !== undefined) {
    try {
      await beforeDispatch?.();
      const result = await callOnBackendNode<{ selected: string[]; labels: string[] }>(
        tabId,
        backendNodeId,
        `function(values) {
          const el = this;
          if (String(el.tagName || "").toLowerCase() !== "select") throw new Error("selectOption 仅用于原生 <select>");
          const requested = values === null ? [] : Array.isArray(values) ? values : [values];
          if (!el.multiple && requested.length > 1) throw new Error("非 multiple 的 select 不能一次选多项");
          for (let i = 0; i < el.options.length; i++) el.options[i].selected = false;
          for (const item of requested) {
            if (item === null) continue;
            let match;
            if (typeof item === "string") {
              const wanted = String(item).trim();
              match = [...el.options].find((o) => o.value === wanted || o.text.trim() === wanted)
                || [...el.options].find((o) => o.text.includes(wanted) || (wanted && wanted.includes(o.text.trim())));
            } else if (typeof item.index === "number") {
              match = el.options[item.index];
              if (!match) throw new Error("select 没有该 index");
            } else if (typeof item.value === "string") {
              match = [...el.options].find((o) => o.value === item.value);
            } else if (typeof item.label === "string") {
              const wanted = item.label.trim();
              match = [...el.options].find((o) => o.text.trim() === wanted)
                || [...el.options].find((o) => o.label === wanted || o.text.includes(wanted));
            }
            if (!match) throw new Error("下拉框没有匹配选项");
            match.selected = true;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            selected: [...el.selectedOptions].map((o) => o.value),
            labels: [...el.selectedOptions].map((o) => o.text.trim()),
          };
        }`,
        [params.values],
        undefined,
        params.expectedDocumentId, beforeDispatch,
      );

      return result;
    } catch (e) {
      if (params.expectedBackendNodeId !== undefined || !isDebuggerUnavailable(e)) {
        throw new Error(`ref @${ref} selectOption 失败（${oneLine(e)}）`);
      }
    }
  }

  await ensureDomOps(tabId, beforeDispatch);

  await beforeDispatch?.();
  return await callDom(
    tabId,
    (t: string, values: unknown) => {
      const dom = window.__sideagent?.dom;

      if (!dom?.selectOption) throw new Error("domops 未注入 selectOption");

      return dom.selectOption(t, values as Parameters<NonNullable<typeof dom.selectOption>>[1]);
    },
    [params.target, params.values],
    params.expectedDocumentId, beforeDispatch,
  );
}

type UploadOutcome = ToolContract["upload_file"]["data"] | { refused: string };

/**
 * 页面内执行（自包含：经 executeScript 或 toString 注入）。where 是元素（AX ref 已解析）、定位串，或 null（找页面上唯一的文件框）。
 * 目标可以是文件框本身、它的 <label>，或只包着一个文件框的容器（常见的自绘上传按钮把文件框藏在里面）。
 * 用 DataTransfer 构造 File 放进 input.files，发冒泡的 input/change，再读回 files 作回执。
 */
function putFilesInPage(where: Element | string | null, files: ToolContract["upload_file"]["params"]["files"]): UploadOutcome {
  const isFileInput = (el: Element | null | undefined): el is HTMLInputElement => el?.tagName === "INPUT" && (el as HTMLInputElement).type === "file";

  const fileInputsIn = (root: ParentNode): HTMLInputElement[] => [...root.querySelectorAll("*")].flatMap(el =>
    [...(isFileInput(el) ? [el] : []), ...(el.shadowRoot ? fileInputsIn(el.shadowRoot) : [])]);

  let input: HTMLInputElement | undefined;

  if (where === null) {
    const found = fileInputsIn(document);
    const [only] = found;

    // 几个文件框时列出可用的 CSS 定位（id、name 或 class），模型下一步直接带 target，不必再读页面。
    const locator = (el: HTMLInputElement) => el.id ? `#${CSS.escape(el.id)}` : el.name ? `input[type=file][name="${el.name}"]` : el.classList.length ? `input[type=file].${[...el.classList].map(c => CSS.escape(c)).join(".")}` : "input[type=file]（无 id/name/class）";

    if (found.length !== 1 || !only) return { refused: found.length === 0 ? "页面上没有文件选择框（input type=file），操作未执行。" : `页面上有 ${found.length} 个文件选择框，请用 target 指定其中一个，操作未执行。候选：${found.slice(0, 6).map(locator).join("、")}` };
    input = only;
  } else {
    const el = typeof where === "string" ? window.__sideagent?.dom?.resolve(where) ?? null : where;

    if (!el) return { refused: "找不到目标元素，操作未执行。请重新 snapshot 后再定位。" };
    const control = el.tagName === "LABEL" ? (el as HTMLLabelElement).control : null;
    const inside = fileInputsIn(el);
    input = isFileInput(el) ? el : isFileInput(control) ? control : inside.length === 1 ? inside[0] : undefined;

    if (!input) return { refused: inside.length > 1 ? `目标里有 ${inside.length} 个文件选择框，请指定其中一个，操作未执行。` : "目标不是文件选择框（input type=file），也不包含文件选择框，操作未执行。" };
  }

  if (input.disabled) return { refused: "文件选择框已禁用，操作未执行。" };

  if (files.length > 1 && !input.multiple) return { refused: `这个文件选择框一次只收一个文件，给了 ${files.length} 个，操作未执行。` };
  const transfer = new DataTransfer();

  for (const file of files) {
    const body = file.base64 !== undefined ? Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)) : file.text ?? "";
    transfer.items.add(new File([body], file.name, { type: file.type }));
  }

  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return { files: [...(input.files ?? [])].map(f => ({ name: f.name, size: f.size, type: f.type })) };
}

/** 上传文件：不开系统选择框、不经本机磁盘；target 缺省时用页面上唯一的文件框。回执只认从文件框读回的文件。 */
export async function uploadFile(
  params: ToolContract["upload_file"]["params"],
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<ToolContract["upload_file"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  await assertObservedDocument(tabId, sessionId, [params.target]);
  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId, beforeDispatch);

  const target = params.target ?? null;
  const backendNodeId = target === null ? undefined : axBackendNodeFor(tabId, parseRef(target));
  let outcome: UploadOutcome;

  if (backendNodeId !== undefined) {
    outcome = await callOnBackendNode<UploadOutcome>(tabId, backendNodeId,
      `function(files) { return (${putFilesInPage.toString()})(this, files); }`, [params.files], undefined, undefined, beforeDispatch);
  } else {
    if (target !== null) await ensureDomOps(tabId, beforeDispatch);
    outcome = await callDom(tabId, putFilesInPage, [target, params.files], undefined, beforeDispatch);
  }

  if ("refused" in outcome) throw notExecuted(new Error(outcome.refused));

  return outcome;
}

export async function typeText(
  params: { text: string; tabId?: number; },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ typed: true }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId);
  await beforeDispatch?.();
  await sendCommand(tab.id, "Input.insertText", { text: params.text },beforeDispatch);

  return { typed: true };
}

export async function pressKey(
  params: { key: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ pressed: true; dialog?: OpenedDialog } | { pressed: false; dialog: OpenedDialog }> {
  const info = resolveKey(params.key);

  if (!info) throw new Error(`不支持的按键: ${params.key}`);
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await beforeDispatch?.();
  await maybeActivateTab(tab, sessionId);

  const heldMods = modifierMaskFor(sessionId, tab.id);

  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers: info.modifiers | heldMods,
  };

  const rawKeyDown: KeyEventParams = { type: info.text === undefined ? "rawKeyDown" : "keyDown", ...base };

  // macOS editing shortcuts need the editor command as well as the synthesized key.
  if (info.code === "KeyA" && (info.modifiers | heldMods) === 4 && navigator.platform.startsWith("Mac")) {
    rawKeyDown.commands = ["selectAll"];
  }

  if (info.code === "KeyV" && ((info.modifiers | heldMods) & 6) !== 0) {
    rawKeyDown.commands = ["paste"];
  }

  if (info.text !== undefined) rawKeyDown.text = info.text;

  await beforeDispatch?.();
  const keyboardTabId = tab.id;
  const dialogWatch = watchDialog(keyboardTabId);
  let interrupted = false;
  let nativeInputs = 0;

  const checkSequence = () => {
    if (interrupted) throw new FillRefused("原生弹窗中断了按键，剩余输入未派发。");
    beforeDispatch?.checkNow?.();
  };

  const sequenceGuard = Object.assign(async () => {
    checkSequence();
    await beforeDispatch?.();
    checkSequence();
  }, {checkNow:checkSequence,noteEffect:() => {
    nativeInputs++;
    const held = heldOf(sessionId);
    held.tabId = keyboardTabId;

    if (nativeInputs === 1) held.keys.set(info.key, info);
    else held.keys.delete(info.key);
    beforeDispatch?.noteEffect?.();
  }});

  const opened = dialogWatch.opened.then(dialog => {
    interrupted = true;

    return { dialog };
  });

  const pressing = (async () => {
    await sendCommand(keyboardTabId, "Input.dispatchKeyEvent", rawKeyDown,sequenceGuard);
    await sendCommand(keyboardTabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base },sequenceGuard);
  })();

  try {
    const settled = await Promise.race([pressing.then(() => ({})), opened]);

    if ("dialog" in settled) {
      pressing.catch(() => {});

      return nativeInputs ? { pressed: true, dialog: settled.dialog } : { pressed: false, dialog: settled.dialog };
    }

    return { pressed: true };
  } finally {
    dialogWatch.stop();
  }
}


export async function scroll(
  params: { dy?: number; toBottom?: boolean; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ atBottom: boolean }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await ensureDomOps(tab.id, beforeDispatch);

  if (params.toBottom) {
    const res = await callDom(
      tab.id,
      (maxSteps: number) => {
        const dom = window.__sideagent?.dom;

        if (!dom) throw new Error("domops 未注入");

        return dom.scrollToBottom(maxSteps);
      },
      [20], undefined, beforeDispatch,
    );

    return { atBottom: res.atBottom };
  }

  const res = await callDom(
    tab.id,
    (dy: number | null) => {
      const dom = window.__sideagent?.dom;

      if (!dom) throw new Error("domops 未注入");

      return dom.scrollBy(dy);
    },
    [params.dy ?? null], undefined, beforeDispatch,
  );

  return { atBottom: res.atBottom };
}

/**
 * mark 工具：在目标元素处画持久标注（描边框+箭头+名牌）。
 * 标注锚定目标元素：window 滚动走文档坐标，内部滚动容器在 scroll 捕获期按包围盒重算。
 * 带 actions 时光标飞到目标拿住，确认/取消双键长在光标名牌上（不在框外）。
 * target 定位串与 click 同语义；注入失败如实报错（标注是显式动作，需要反馈）。
 */
export async function mark(
  params: {
    tabId?: number;
    target: string;
    through?: string;
    label?: string;
    actions?: unknown;
    style?: "rect" | "sketch";
    motion?: "grow" | "boil";
  },
  sessionId: string = LEAD_SESSION_ID,
  beforeDispatch?: DispatchGuard,
): Promise<{ marked: true }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const observedDocument = await assertObservedDocument(tab.id, sessionId, [params.target, params.through]);
  const tabId = tab.id;
  const cid = cursorId(sessionId);

  // 与 click 同样的解析策略：AX 快照 ref 走 CDP，其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = axBackendNodeFor(tabId, ref);
  const throughNodeId = params.through === undefined ? undefined : axBackendNodeFor(tabId, parseRef(params.through));

  if (params.through !== undefined && (backendNodeId === undefined || throughNodeId === undefined)) {
    throw notExecuted(new Error(`through 只能配合当前快照里的 @ref：target 和 through 都要是同一张快照的 @N（收到 ${params.target} → ${params.through}）`));
  }

  let rect: DomRect | undefined;
  let prepared = false;
  try {

    if (backendNodeId !== undefined) {
      try {
        rect = await rectOfBackendNode(tabId, backendNodeId, true, beforeDispatch);
        prepared = true;
      } catch (e) {
        if (!isDebuggerUnavailable(e)) {
          if (e && typeof e === "object" && "executionFact" in e) throw e;
          throw notExecuted(new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`));
        }
      }
    }

    if (!rect) {
      await ensureDomOps(tabId, beforeDispatch);

      const res = await callDom(
        tabId,
        (t: string): { ok: true; rect: DomRect } | { ok: false; error: string } => {
          const dom = window.__sideagent?.dom;

          if (!dom) return { ok: false, error: "domops 未注入" };

          try {
            const element = dom.resolve(t);

            if (element === document.body || element === document.documentElement) throw new Error("请定位具体内容元素，不能用整页作为标注目标");

            return { ok: true, rect: dom.rectOf(t) };
          } catch (e: any) {
            return { ok: false, error: e?.message ?? String(e) };
          }
        },
        [params.target], undefined, beforeDispatch,
      );

      // 只是定位，还没画任何东西：失败一律是「未执行」，不能记成结果未知而锁住重画。
      if (!res || !res.ok) {
        throw notExecuted(new Error(res?.ok === false ? res.error : `未找到目标元素：${params.target}`));
      }

      if (!res.rect || typeof res.rect.x !== "number") {
        throw notExecuted(new Error(`未找到目标元素：${params.target}`));
      }

      rect = res.rect;
      prepared = true;
    }

    await ensureCursor(tabId, beforeDispatch);
    const actions = resolveImplicitMarkActions(params.label, params.actions) ?? null;
    const motion = await getMarkMotion();
    const style = params.style ?? "sketch";
    await assertSameDocument(tabId, observedDocument);

    if (backendNodeId !== undefined && throughNodeId !== undefined) {
      const contextId = await cursorContext(tabId);
      const end = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: throughNodeId, executionContextId: contextId });

      if (!end.object?.objectId) throw notExecuted(new Error(`ref ${params.through} 已失效，操作未执行。请重新 snapshot 后使用新的 ref`));
      await assertSameDocument(tabId, observedDocument);

      // 同一行、同一页面的校验在页面里做；没通过时什么都还没画，如实记为未执行。
      {
        await callOnBackendNode(tabId, backendNodeId, `function(end,label,target,id,actions,options) {
          const {range, rect} = (${observedNodeRange.toString()}).call(this,end,(${observedNodeRect.toString()}));
          window.__sideagent.cursor.for(id).mark(rect,label ?? undefined,target,actions ?? undefined,options,range);
        }`, [new CdpObjectArg(end.object.objectId), params.label ?? null, params.target, cid, actions, { style, motion }], contextId, undefined, beforeDispatch);
      }

      return { marked: true };
    }

    if (backendNodeId !== undefined) {
      const contextId = await cursorContext(tabId);
      await assertSameDocument(tabId, observedDocument);
      await callOnBackendNode(tabId, backendNodeId, `function(label,target,id,actions,options) {
        const rect = (${observedNodeRect.toString()}).call(this,true);
        window.__sideagent.cursor.for(id).mark(rect,label ?? undefined,target,actions ?? undefined,options,this);
      }`, [params.label ?? null,params.target,cid,actions,{style,motion}], contextId, undefined, beforeDispatch);

      return {marked:true};
    }

    await callDom(
      tabId,
      (
        r: DomRect,
        l: string | null,
        t: string,
        id: string,
        a: Array<{ id: "confirm" | "cancel"; label: string }> | null,
        opts: { style?: "rect" | "sketch"; motion?: "grow" | "boil" },
      ) => {
        const cursor = window.__sideagent?.cursor?.for(id);

        if (!cursor?.mark) throw new Error("cursor 未注入");
        cursor.mark(r, l ?? undefined, t, a ?? undefined, opts);
      },
      [rect, params.label ?? null, params.target, cid, actions, { style, motion }], undefined, beforeDispatch,
    );

    return { marked: true };
  } catch (error) {
    if (beforeDispatch && prepared) throw Object.assign(error instanceof Error ? error : new Error(String(error)), {executionFact: "unknown"});
    throw error;
  }
}

/** clear_marks 工具：清除全部 mark 标注。受限页面本来就画不上标注，静默成功。 */
export async function clearMarks(sessionId: string = LEAD_SESSION_ID, tabId?: number, beforeDispatch?: DispatchGuard): Promise<{ cleared: true }> {
  await beforeDispatch?.();
  const tab = await resolveWorkingTab(tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  try {
    await ensureCursor(tab.id, beforeDispatch);
    await callDom(tab.id, () => window.__sideagent?.cursor?.clearMarks?.(), [], undefined, beforeDispatch);
  } catch (error) {
    if (beforeDispatch) throw error;
    /* 页面禁止注入（如 chrome://）时没有标注可清，静默 */
  }

  return { cleared: true };
}
