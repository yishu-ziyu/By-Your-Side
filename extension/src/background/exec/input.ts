import {assertObservedDocument, assertSameDocument} from "../observation-document.js";
import {replaceEditableText} from "../../shared/editable-text.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { documentPoint, pointsOnTab } from "../../shared/cursor-trail.js";
import { recordTrailPoint, trailForReplay } from "./trail.js";
import { holdAttach, releaseAttachHold, sendCommand } from "../debugger.js";
import { getWorkingTabId, maybeActivateTab, resolveWorkingTab } from "../state.js";
import { resolveKey, type KeyInfo } from "../../shared/keymap.js";
import { isAxRef } from "../axstate.js";
import { observedNodeRect } from "../observed-node-rect.js";
import { cursorContext } from "../cursor-context.js";
import { oneLine } from "../util.js";
import {
  confirmLabelForDestructive,
  isDestructiveLabel,
  resolveImplicitMarkActions,
} from "../../shared/mark-actions.js";
import { HeldClicks } from "../../shared/held-clicks.js";
import { getMarkMotion } from "../mode.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { beginEffect, collectEffect } from "./effect.js";
import { switchTab } from "./tabs.js";
import type { EffectReport } from "../../../../shared/effect.js";
import type { ToolExecutionFact } from "../../../../shared/protocol.js";
import {
  createIsolatedClipboardBridge,
  normalizePasteContent,
  pasteChord,
  pointInElementRect,
  pressedButtonsMask,
  type ClipboardBridge,
  type ClipboardFinishStatus,
  type ElementPosition,
  type MouseButton,
  type PasteContent,
} from "../../../../shared/pointer-input.js";

export type {
  ClipboardBridge,
  ClipboardFinishStatus,
  ElementPosition,
  MouseButton,
  PasteContent,
} from "../../../../shared/pointer-input.js";

export {
  createIsolatedClipboardBridge,
  normalizePasteContent,
  pasteChord,
  pointInElementRect,
} from "../../../../shared/pointer-input.js";

/** 未配置剪贴板桥时拒绝 paste；禁止用合成事件假报成功。 */
export const PASTE_HOST_BLOCKED =
  "BLOCKED: 富文本 paste 需要宿主剪贴板桥（保存/恢复 text+html，并发 changeCount 检查）。扩展默认未接真实剪贴板；测试请注入 createIsolatedClipboardBridge，合并票再接 macOS pasteboard。";

let clipboardBridge: ClipboardBridge | null = null;

/** 测试或宿主注入；null 表示正式 paste 记 BLOCKED。 */
export function setClipboardBridge(bridge: ClipboardBridge | null): void {
  clipboardBridge = bridge;
}

export function getClipboardBridge(): ClipboardBridge | null {
  return clipboardBridge;
}

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

function clearHeldRecord(sessionId: string): void {
  heldInputs.delete(sessionId);
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

/** 把 backendDOMNodeId 解析成页面内元素并执行函数（CDP Runtime.callFunctionOn）。 */
export async function callOnBackendNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args?: unknown[],
  executionContextId?: number,
  expectedDocumentId?: string,
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
    backendNodeId,
    ...(executionContextId !== undefined ? {executionContextId} : {}),
  });

  const objectId = resolved.object?.objectId;

  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");

  if(expectedDocumentId) {
    try { await assertSameDocument(tabId,expectedDocumentId); }
    catch(error) { throw notExecuted(error); }
  }

  const result = await sendCommand<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    ...(args ? { arguments: args.map((value) => ({ value })) } : {}),
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败",
    );
  }

  return result.result?.value as T;
}

/** AX ref → 元素视口包围盒（scrollIntoView + getBoundingClientRect）。 */
async function rectOfBackendNode(tabId: number, backendNodeId: number, contentOnly = false): Promise<DomRect> {
  const rect = await callOnBackendNode<DomRect | undefined>(
    tabId,
    backendNodeId,
    observedNodeRect.toString(),
    [contentOnly],
  );

  if (!rect) throw new Error("无法获取元素位置");

  return rect;
}

/** AX ref → 填充（原生 value setter + input/change 事件，与 domops fill 同逻辑）。 */
async function fillBackendNode(tabId: number, backendNodeId: number, value: string, expectedDocumentId?:string): Promise<void> {
  await callOnBackendNode<unknown>(
    tabId,
    backendNodeId,
    `function(v) {
      const el = this;
      el.focus();
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        const wanted = String(v).trim();
        const opts = [...el.options].map((o) => ({ text: o.text, value: o.value }));
        const exact = opts.find((o) => o.text.trim() === wanted || o.value === wanted);
        const match = exact ?? opts.find((o) => o.text.includes(wanted) || (wanted && wanted.includes(o.text.trim())));
        if (!match || !match.text.trim()) throw new Error("下拉框没有这个选项");
        el.value = match.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        (${replaceEditableText.toString()})(el, v);
        return true;
      }
      throw new Error("元素不可填充（非 input/textarea/select/contenteditable）");
    }`,
    [value],
    undefined,
    expectedDocumentId,
  );
}

async function ensureDomOps(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-domops.js"],
    world: "ISOLATED",
  });
}

export async function ensureCursor(tabId: number): Promise<void> {
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
): Promise<Awaited<Result>> {
  const results = await chrome.scripting.executeScript<Args, Result>({
    target: { tabId, ...(documentId?{documentIds:[documentId]}:{}) },
    world: "ISOLATED",
    func,
    args,
  });

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
  /** 只在 held 台账里出现：确认后要重放的动作类型；click 调用本身不带。 */
  kind?: "double_click";
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
  kind?: "drag";
};

type HoldParams = ClickParams | DragParams;

type ClickResult = { clicked: true; effect?: EffectReport; newTab?: { tabId: number; url?: string } } | { clicked: false; held: true };

/** held/arm 台账抽成纯数据层（shared/held-clicks.ts），决策逻辑可单测。 */
const heldClicks = new HeldClicks<HoldParams>(LEAD_SESSION_ID);

export function armDestructiveClick(sessionId: string = LEAD_SESSION_ID): void {
  heldClicks.arm(sessionId);
}

export function hasPendingDestructiveClick(sessionId: string = LEAD_SESSION_ID): boolean {
  return heldClicks.hasPending(sessionId);
}

export function dropPendingClicks(sessionId: string = LEAD_SESSION_ID): void {
  heldClicks.drop(sessionId);
}

export function dropAllPendingClicks(): void {
  heldClicks.dropAll();
}

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

export async function showUserControlBanner(tabId?: number, sessionId: string = LEAD_SESSION_ID, view?: ControlBannerView | null): Promise<void> {
  const owner = bannerOwnerKey(sessionId);
  const revision = beginBannerShow(owner);
  const ids = new Set<number>();

  if (tabId != null) ids.add(tabId);
  else {
    const fallback = await resolveOverlayTabId(sessionId);

    if (fallback != null) ids.add(fallback);

    try {
      const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});

      if (active?.id != null) ids.add(active.id);
    } catch { /* 无活动页 */ }
  }

  await showControlBanners(ids, view, owner, revision);
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

export async function resolveHeldClick(
  action: "confirm" | "cancel",
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ clicked: boolean }> {
  const decision = heldClicks.resolve(action, sessionId);

  if (decision.kind === "cancelled") {
    const sid = decision.sessionId ?? sessionId;

    try {
      await clearMarks(sid);
    } catch {
      /* 没有标注可清 */
    }

    await releaseHold(sid);
    await releaseHeldInputs(sid);

    return { clicked: false };
  }

  if (decision.kind === "armOnce") {
    // 模型自绘 mark 路径：pending 无记录，点「确认」直接 arm，模型重试 click 一次通过
    return { clicked: false };
  }

  // 确认：先松开拿住态，再由同一只手按台账里记录的动作真实派发
  await releaseHold(decision.sessionId);

  try {
    const stored = decision.params;

    if ("from" in stored) {
      await drag(stored, decision.sessionId);
    } else if (stored.kind === "double_click") {
      await doubleClick(stored, decision.sessionId);
    } else {
      await click(stored, decision.sessionId);
    }

    return { clicked: true };
  } finally {
    heldClicks.drop(decision.sessionId);
  }
}

/** destructive 目标：拿住不派发，把「确认后要重放的动作」记进台账，视觉锚（框/名牌双键）照旧。 */
async function holdForConfirmation(
  tab: chrome.tabs.Tab,
  sessionId: string,
  name: string,
  stored: HoldParams,
  visual: { target?: string; targetRect?: DomRect; point?: [number, number] },
): Promise<void> {
  heldClicks.hold(sessionId, stored);
  await maybeActivateTab(tab, sessionId);
  const tabId = tab.id!;
  const cid = cursorId(sessionId);
  const confirmLabel = confirmLabelForDestructive(name);

  const actions = [
    { id: "confirm" as const, label: confirmLabel },
    { id: "cancel" as const, label: "取消" },
  ];

  // C 案：框（mark）留作视觉锚；键不在框外——cursor.mark 带 actions 时
  // 光标自己飞到目标拿住，双键长在名牌上（与模型自绘 mark 同一形态，只有一套键）。
  try {
    if (visual.target) {
      await mark({ target: visual.target, label: "待确认", actions }, sessionId);
    } else if (visual.targetRect) {
      await ensureCursor(tabId);
      await callDom(
        tabId,
        (
          r: DomRect,
          l: string,
          id: string,
          a: Array<{ id: "confirm" | "cancel"; label: string }>,
        ) => {
          const cursor = window.__sideagent?.cursor?.for(id);

          if (!cursor?.mark) throw new Error("cursor 未注入");
          cursor.mark(r, l, undefined, a);
        },
        [visual.targetRect, "待确认", cid, actions],
      );
    } else if (visual.point) {
      // 只有坐标没有元素：画不出框，手仍飞过去拿住（锚点取该位置的元素）
      await ensureCursor(tabId);
      await callDom(
        tabId,
        (x: number, y: number, id: string, a: Array<{ id: "confirm" | "cancel"; label: string }>) => {
          const cursor = window.__sideagent?.cursor?.for(id);

          if (!cursor?.hold) throw new Error("cursor 未注入");
          cursor.hold(x, y, a);
        },
        [visual.point[0], visual.point[1], cid, actions],
      );
    }
  } catch {
    /* 画不出标注也先不派发：侧栏打「确认」仍可放行 */
  }
}

async function nameOfClickTarget(
  tabId: number,
  params: ClickParams,
): Promise<string> {
  const labeled = params.label?.trim();

  if (labeled) return labeled;
  const target = params.target;

  if (!target) return "";
  const ref = parseRef(target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  const read = `function() {
    const el = this;
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

async function resolvePointerTarget(
  tabId: number,
  params: ClickParams,
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
    const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;
    let resolvedViaCdp = false;

    if (backendNodeId !== undefined) {
      try {
        targetRect = await rectOfBackendNode(tabId, backendNodeId);

        if (!isDomRect(targetRect)) throw new Error("无法获取元素位置");

        if (!point) {
          point = pointInElementRect(targetRect, params.position);
        }

        resolvedViaCdp = true;
      } catch (e) {
        if (!isDebuggerUnavailable(e)) {
          throw notExecuted(new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`));
        }
        // debugger 不可用：落到 domops 路径（注意此时 @N 依赖 DOM 快照的 refs，
        // 若上次快照是 AX 版会解析不到——属边缘情况，让 domops 报「已失效」即可）
      }
    }

    if (!resolvedViaCdp && !point) {
      await ensureDomOps(tabId);

      const res = await callDom(
        tabId,
        readDomTargetRect,
        [target],
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

const CONFIRM_CLICK_JS = `function() {
  ${TARGET_OWNS_HIT_JS}
  const el = this;
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
  const el = this;
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

/** 视觉等待后再次确认同一目标仍存在且可命中；失败则停，不点原坐标处的其他对象。 */
async function confirmPointerTarget(
  tabId: number,
  target: string,
): Promise<{ point: [number, number]; targetRect: DomRect }> {
  const ref = parseRef(target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  if (backendNodeId !== undefined) {
    try {
      const rect = await callOnBackendNode<DomRect | undefined>(tabId, backendNodeId, CONFIRM_CLICK_JS);

      if (!rect || typeof rect.x !== "number") throw new Error("无法确认目标位置");

      return {
        targetRect: rect,
        point: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)],
      };
    } catch (e) {
      if (!isDebuggerUnavailable(e)) {
        const msg = oneLine(e);

        if (/已失效|覆盖|可命中|不可见/.test(msg)) throw notExecuted(new Error(msg));
        throw notExecuted(new Error(
          `ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${msg}）`,
        ));
      }
    }
  }

  await ensureDomOps(tabId);

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
    [target],
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
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  if (backendNodeId !== undefined) {
    try {
      await callOnBackendNode<boolean>(tabId, backendNodeId, HIT_TEST_AT_JS, [x, y]);

      return;
    } catch (e) {
      if (!isDebuggerUnavailable(e)) {
        const msg = oneLine(e);

        if (/已失效|覆盖|可命中|不可见/.test(msg)) throw notExecuted(new Error(msg));
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

    return { tabId: opened.id, ...(opened.url ? { url: opened.url } : {}) };
  } catch {
    return undefined;
  }
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
): Promise<{ hovered: true }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  const { point: [x, y] } = await resolvePointerTarget(tab.id, params);
  await maybeActivateTab(tab, sessionId);
  const cid = cursorId(sessionId);
  const actionId = await beginCursorAction(tab.id, cid, "hover", params.target, params.label);

  try {
    await cursorMove(tab.id, x, y, cid);
    await sendCommand(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await endCursorAction(tab.id, cid, actionId, "done");
  } catch (error) {
    await endCursorAction(tab.id, cid, actionId, "failed");
    throw error;
  }

  await recordCursorTrail(tab.id, sessionId, x, y, false);

  return { hovered: true };
}

export async function click(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
): Promise<ClickResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
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

  const { point, targetRect } = await resolvePointerTarget(tabId, params);

  const name = await nameOfClickTarget(tabId, params);
  const wasArmed = heldClicks.isArmed(sessionId);

  if (isDestructiveLabel(name) && !wasArmed) {
    await holdForConfirmation(tab, sessionId, name, { ...params }, { target: params.target, targetRect, point });

    return { clicked: false, held: true };
  }

  if (isDestructiveLabel(name) && wasArmed) {
    heldClicks.drop(sessionId);
  }

  await maybeActivateTab(tab, sessionId);

  let [x, y] = point!;

  if (!target) {
    await callPointGuard(tabId, x, y, "remember");
  }

  const button: MouseButton = params.button ?? "left";
  const clickCount = Math.max(1, Math.floor(params.clickCount ?? 1));
  const force = params.force === true;
  const modifiers = modifierMaskFor(sessionId, tab.id);

  const actionId = await beginCursorAction(tabId, cid, "click", target, name);

  try {
    // 目标边框与浅弧移动并行；不再为高亮和预播放波纹额外等待。
    await cursorMove(tabId, x, y, cid);

    if (target && !force) {
      const confirmed = await confirmPointerTarget(tabId, target);

      if (params.position) {
        [x, y] = pointInElementRect(confirmed.targetRect, params.position);
      } else {
        x = confirmed.point[0];
        y = confirmed.point[1];
      }

      if (x !== point[0] || y !== point[1]) {
        await cursorMove(tabId, x, y, cid);
      }
    }

    let cdpMouseMoved = false;
    let cdpMousePressed = false;
    let effect: EffectReport | undefined;

    try {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
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

      for (let n = 1; n <= clickCount; n++) {
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          buttons: pressedButtonsMask(button) | buttonsMaskFor(sessionId),
          clickCount: n,
          modifiers,
        });
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

      effect = await collectEffect(tabId, effectToken);
    } catch (e) {
      if (cdpMousePressed) {
        throw new Error(
          `点击可能已送达，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }

      if (cdpMouseMoved) {
        if (isPrePressTargetError(e)) throw notExecuted(e);
        throw new Error(
          `点击是否送达无法确认，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }

      // 尚未向页面派发任何 CDP 输入（如 DevTools 占用）时，才允许 DOM 回退一次
      // 右键/中键/非左键不提供 DOM 回退（document 无法等价 contextmenu/中键）。
      if (target && button === "left" && clickCount === 1 && !force) {
        await ensureDomOps(tabId);
        const fallbackToken = await beginEffect(tabId, { point: [x, y] });
        await callDom(
          tabId,
          (t: string) => {
            const dom = window.__sideagent?.dom;

            if (!dom) throw new Error("domops 未注入");

            return dom.click(t);
          },
          [target],
        );
        const fallbackEffect = await collectEffect(tabId, fallbackToken);
        await endCursorAction(tabId, cid, actionId, "done", [x, y]);
        await recordCursorTrail(tabId, sessionId, x, y, true);

        return { clicked: true, ...(fallbackEffect ? { effect: fallbackEffect } : {}) };
      }

      throw e;
    }

    await endCursorAction(tabId, cid, actionId, "done", [x, y]);
    await recordCursorTrail(tabId, sessionId, x, y, true);
    const newTab = tabsBefore.size ? await followOpenedTab(tabsBefore, tabId, sessionId) : undefined;

    return { clicked: true, ...(effect ? { effect } : {}), ...(newTab ? { newTab } : {}) };
  } catch (error) {
    const unknown = /可能已送达|是否送达无法确认/.test(oneLine(error));
    await endCursorAction(tabId, cid, actionId, unknown ? "unknown" : "failed");
    throw error;
  }
}

type DoubleClickResult =
  | { doubleClicked: true; effect?: EffectReport; newTab?: { tabId: number; url?: string } }
  | { doubleClicked: false; held: true };

type DragResult = { dragged: true; effect?: EffectReport } | { dragged: false; held: true };

/**
 * 真实双击：与 click 同一解析/确认/命中核对/effect 管线，CDP clickCount 1→2。
 * 不提供 DOM dispatchEvent 伪造回退——伪造双击不算双击能力（Issue §五）。
 */
export async function doubleClick(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
): Promise<DoubleClickResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
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

  const { point, targetRect } = await resolvePointerTarget(tabId, params);
  const name = await nameOfClickTarget(tabId, params);
  const wasArmed = heldClicks.isArmed(sessionId);

  if (isDestructiveLabel(name) && !wasArmed) {
    await holdForConfirmation(tab, sessionId, name, { ...params, kind: "double_click" }, { target: params.target, targetRect, point });

    return { doubleClicked: false, held: true };
  }

  if (isDestructiveLabel(name) && wasArmed) {
    heldClicks.drop(sessionId);
  }

  await maybeActivateTab(tab, sessionId);

  let [x, y] = point!;

  if (!params.target) {
    await callPointGuard(tabId, x, y, "remember");
  }

  const button: MouseButton = params.button ?? "left";
  const force = params.force === true;
  const modifiers = modifierMaskFor(sessionId, tab.id);
  const actionId = await beginCursorAction(tabId, cid, "click", params.target, name);

  try {
    await cursorMove(tabId, x, y, cid);

    if (params.target && !force) {
      const confirmed = await confirmPointerTarget(tabId, params.target);

      if (params.position) {
        [x, y] = pointInElementRect(confirmed.targetRect, params.position);
      } else {
        x = confirmed.point[0];
        y = confirmed.point[1];
      }

      if (x !== point![0] || y !== point![1]) {
        await cursorMove(tabId, x, y, cid);
      }
    }

    let dispatched = false;
    let pressed = false;
    let effect: EffectReport | undefined;

    try {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
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
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, buttons: btnMask | buttonsMaskFor(sessionId), clickCount: 1, modifiers,
      });
      pressed = true;
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, buttons: buttonsMaskFor(sessionId), clickCount: 1, modifiers,
      });
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, buttons: btnMask | buttonsMaskFor(sessionId), clickCount: 2, modifiers,
      });
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, buttons: buttonsMaskFor(sessionId), clickCount: 2, modifiers,
      });
      effect = await collectEffect(tabId, effectToken);
    } catch (e) {
      if (pressed) {
        throw new Error(`双击可能已送达，后续 CDP 返回异常，未再次双击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`);
      }

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

    return { doubleClicked: true, ...(effect ? { effect } : {}), ...(newTab ? { newTab } : {}) };
  } catch (error) {
    const unknown = /可能已送达|是否送达无法确认/.test(oneLine(error));
    await endCursorAction(tabId, cid, actionId, unknown ? "unknown" : "failed");
    throw error;
  }
}

/**
 * 真实拖拽：from/to 各为 target 或视口 point；mouseMoved→press→有界 move 序列→release。
 * 不提供 DOM drag/drop 事件伪造回退；HTML5 原生拖拽的兼容性由 acceptance 如实记录。
 */
export async function drag(
  params: DragParams,
  sessionId: string = LEAD_SESSION_ID,
): Promise<DragResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);

  if (!params.from || !params.to || (!params.from.target && !params.from.point) || (!params.to.target && !params.to.point)) {
    throw notExecuted(new Error("drag 需要 from 与 to（各为 target 或 point），未执行"));
  }

  const tabId = tab.id;
  const cid = cursorId(sessionId);

  const from = await resolvePointerTarget(tabId, {
    target: params.from.target,
    point: params.from.point,
    position: params.from.position,
  });

  const to = await resolvePointerTarget(tabId, {
    target: params.to.target,
    point: params.to.point,
    position: params.to.position,
  });

  const name = params.label?.trim()
    || (params.from.target ? await nameOfClickTarget(tabId, { target: params.from.target }) : "");

  const wasArmed = heldClicks.isArmed(sessionId);

  if (isDestructiveLabel(name) && !wasArmed) {
    await holdForConfirmation(tab, sessionId, name, { ...params, kind: "drag" }, { target: params.from.target, targetRect: from.targetRect, point: from.point });

    return { dragged: false, held: true };
  }

  if (isDestructiveLabel(name) && wasArmed) {
    heldClicks.drop(sessionId);
  }

  await maybeActivateTab(tab, sessionId);

  const [x0, y0] = from.point;
  const [tx, ty] = to.point;
  let x = x0;
  let y = y0;

  if (!params.from.target) {
    await callPointGuard(tabId, x, y, "remember");
  }

  const actionId = await beginCursorAction(tabId, cid, "click", params.from.target, name);

  try {
    await cursorMove(tabId, x, y, cid);

    if (params.from.target) {
      const confirmed = await confirmPointerTarget(tabId, params.from.target);

      if (params.from.position) {
        x = pointInElementRect(confirmed.targetRect, params.from.position)[0];
        y = pointInElementRect(confirmed.targetRect, params.from.position)[1];
      } else {
        x = confirmed.point[0];
        y = confirmed.point[1];
      }

      if (x !== x0 || y !== y0) {
        await cursorMove(tabId, x, y, cid);
      }
    }

    let dispatched = false;
    let pressed = false;
    let last: [number, number] = [x, y];
    let effect: EffectReport | undefined;
    const modifiers = modifierMaskFor(sessionId, tab.id);

    try {
      // 效果基线取落点区域：拖拽的可观察变化通常发生在目标位置。
      const effectPending = beginEffect(tabId, { point: [tx, ty] });
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      dispatched = true;
      heldOf(sessionId).pointer = [x, y];

      if (params.from.target) {
        await hitTestPointerTarget(tabId, params.from.target, x, y);
      } else {
        await callPointGuard(tabId, x, y, "confirm");
      }

      const effectToken = await effectPending;
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers,
      });
      pressed = true;
      const distance = Math.hypot(tx - x, ty - y);
      const steps = Math.min(20, Math.max(4, Math.ceil(distance / 60)));

      for (let i = 1; i <= steps; i++) {
        const mx = Math.round(x + ((tx - x) * i) / steps);
        const my = Math.round(y + ((ty - y) * i) / steps);
        last = [mx, my];
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1, modifiers,
        });

        if (i < steps) await new Promise(r => setTimeout(r, 12));
      }

      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1, modifiers,
      });
      pressed = false;
      heldOf(sessionId).pointer = [tx, ty];
      effect = await collectEffect(tabId, effectToken);
    } catch (e) {
      if (pressed) {
        // 按下后的任何失败都先把键弹起来，不能让按钮卡住；弹起失败不掩盖原错误。
        try {
          await sendCommand(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased", x: last[0], y: last[1], button: "left", buttons: 0, clickCount: 1, modifiers,
          });
          pressed = false;
        } catch { /* 原错误优先 */ }

        throw new Error(`拖拽可能已送达，未重复执行（${oneLine(e)}）。请 snapshot 核验当前页面状态，不要当作未执行而重试。`);
      }

      if (dispatched) {
        if (isPrePressTargetError(e)) throw notExecuted(e);
        throw new Error(`拖拽是否送达无法确认，未重复执行（${oneLine(e)}）。请 snapshot 核验当前页面状态。`);
      }

      if (isPrePressTargetError(e)) throw notExecuted(e);
      throw notExecuted(new Error(`拖拽未执行（${oneLine(e)}）。本工具不提供 DOM drag/drop 伪造回退；请 snapshot 核验目标与调试器状态后重试。`));
    }

    await endCursorAction(tabId, cid, actionId, "done", [tx, ty]);
    await recordCursorTrail(tabId, sessionId, tx, ty, false);

    return { dragged: true, ...(effect ? { effect } : {}) };
  } catch (error) {
    const unknown = /可能已送达|是否送达无法确认/.test(oneLine(error));
    await endCursorAction(tabId, cid, actionId, unknown ? "unknown" : "failed");
    throw error;
  }
}

export async function fill(
  params: { target: string; value: string; tabId?: number; expectedDocumentId?:string; expectedBackendNodeId?:number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ filled: true }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  if(params.expectedDocumentId) {
    try { await assertSameDocument(tab.id,params.expectedDocumentId); }
    catch(error) { throw notExecuted(error); }
  }

  await assertObservedDocument(tab.id, sessionId);
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  await maybeActivateTab(tab, sessionId);

  // AX 快照的 @N（ref 即 backendDOMNodeId）走 CDP（同 domops fill 逻辑）；其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  if(params.expectedBackendNodeId!==undefined && backendNodeId!==params.expectedBackendNodeId) {
    throw notExecuted(new Error('原 AX 对象身份无法核对，填写未执行。'));
  }

  // 操作前在 scrollIntoView 之后取目标包围盒，动作边框持续到操作返回。
  let targetRect: DomRect | undefined;

  if (backendNodeId !== undefined) {
    try {
      targetRect = await rectOfBackendNode(tabId, backendNodeId);
    } catch (e) {
      if (params.expectedBackendNodeId!==undefined || !isDebuggerUnavailable(e)) {
        throw new Error(`ref @${ref} 填充失败（${oneLine(e)}）`);
      }
      // debugger 不可用时落到 domops
    }
  }

  if (!targetRect) {
    try {
      await ensureDomOps(tabId);

      const res = await callDom(
        tabId,
        readDomTargetRect,
        [params.target],
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

  const actionId = await beginCursorAction(tabId, cid, "fill", params.target);

  try {
    if (targetRect) {
      await cursorMove(tabId, Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2), cid);
    }

    // 2. 真实填充操作
    if(params.expectedDocumentId) {
      try { await assertSameDocument(tabId,params.expectedDocumentId); }
      catch(error) { throw notExecuted(error); }
    }

    if (backendNodeId !== undefined) {
      try {
        await fillBackendNode(tabId, backendNodeId, params.value, params.expectedDocumentId);

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

        return { filled: true };
      } catch (e) {
        if (params.expectedBackendNodeId!==undefined || !isDebuggerUnavailable(e)) {
          throw new Error(`ref @${ref} 填充失败（${oneLine(e)}）`);
        }
        // debugger 不可用时落到 domops（其 refs 若无此 ref 会报「已失效」）
      }
    }

    await ensureDomOps(tabId);
    await callDom(
      tabId,
      (t: string, v: string) => {
        const dom = window.__sideagent?.dom;

        if (!dom) throw new Error("domops 未注入");

        return dom.fill(t, v);
      },
      [params.target, params.value],
      params.expectedDocumentId,
    );

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

    return { filled: true };
  } catch (error) {
    await endCursorAction(tabId, cid, actionId, "unknown");
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

  await assertObservedDocument(tab.id, sessionId);
  const tabId = tab.id;
  await maybeActivateTab(tab, sessionId);

  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  if (params.expectedBackendNodeId !== undefined && backendNodeId !== params.expectedBackendNodeId) {
    throw notExecuted(new Error("原 AX 对象身份无法核对，选择未执行。"));
  }

  if (backendNodeId !== undefined) {
    try {
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
        params.expectedDocumentId,
      );

      return result;
    } catch (e) {
      if (params.expectedBackendNodeId !== undefined || !isDebuggerUnavailable(e)) {
        throw new Error(`ref @${ref} selectOption 失败（${oneLine(e)}）`);
      }
    }
  }

  await ensureDomOps(tabId);

  return await callDom(
    tabId,
    (t: string, values: unknown) => {
      const dom = window.__sideagent?.dom;

      if (!dom?.selectOption) throw new Error("domops 未注入 selectOption");

      return dom.selectOption(t, values as Parameters<NonNullable<typeof dom.selectOption>>[1]);
    },
    [params.target, params.values],
    params.expectedDocumentId,
  );
}

export async function typeText(
  params: { text: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ typed: true }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  await sendCommand(tab.id, "Input.insertText", { text: params.text });

  return { typed: true };
}

export async function pressKey(
  params: { key: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ pressed: true }> {
  const info = resolveKey(params.key);

  if (!info) throw new Error(`不支持的按键: ${params.key}`);
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);

  const heldMods = modifierMaskFor(sessionId, tab.id);

  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers: info.modifiers | heldMods,
  };

  await sendCommand(tab.id, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base,
    // macOS editing shortcuts need the editor command as well as the synthesized key.
    ...(info.code === "KeyA" && (info.modifiers | heldMods) === 4 && navigator.platform.startsWith("Mac")
      ? { commands: ["selectAll"] } : {}),
    ...(info.code === "KeyV" && ((info.modifiers | heldMods) & 6) !== 0
      ? { commands: ["paste"] } : {}),
    ...(info.text !== undefined ? { text: info.text } : {}),
  });
  await sendCommand(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });

  return { pressed: true };
}

/**
 * Real pointer wheel. ACKs prove protocol delivery, not scrolling or task
 * completion. A lost reply never causes the nonzero delta to be sent again.
 * checkCurrent is supplied by the dispatcher, never by model parameters.
 */
export async function wheel(
  params: {
    deltaX?: number;
    deltaY?: number;
    point?: [number, number];
    target?: string;
    position?: ElementPosition;
    tabId?: number;
    label?: string;
  },
  sessionId: string = LEAD_SESSION_ID,
  checkCurrent: () => void = () => {},
): Promise<{ wheeled: true; point: [number, number]; ackMs: number; attempts: number }> {
  checkCurrent();
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const documentId = await assertObservedDocument(tab.id, sessionId);
  checkCurrent();
  await maybeActivateTab(tab, sessionId);
  let point = params.point;

  if (!point && params.target) {
    point = (await resolvePointerTarget(tab.id, {
      target: params.target,
      position: params.position,
    })).point;
  }

  if (!point) point = heldOf(sessionId).pointer ?? undefined;

  if (!point) throw notExecuted(new Error("wheel 需要 point/target，或先 move/click 建立指针位置；未执行"));
  const deltaX = params.deltaX ?? 0;
  const deltaY = params.deltaY ?? 0;

  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !point.every(Number.isFinite)) {
    throw notExecuted(new Error("wheel deltaX/deltaY 必须是有限数字；未执行"));
  }

  // 窗口未聚焦时不抢前台（见 foreground.ts），工作页可能留在后台；Chrome 不给隐藏页处理滚轮，
  // 发出去只会等到超时、落成「是否滚过未知」。先查可见性，隐藏就明确不执行。
  const visibility = await sendCommand<{ result?: { value?: unknown } }>(tab.id, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });

  if (visibility.result?.value === "hidden") {
    throw notExecuted(new Error("工作标签页在后台（窗口未聚焦时不抢前台），浏览器不会处理滚轮；未执行。可改用 scroll 工具，或请用户切回这个窗口后再试"));
  }

  const [x, y] = point;
  const modifiers = modifierMaskFor(sessionId, tab.id);
  const tabId = tab.id;
  const ACK_MS = 5000;
  const MOVE_ACK_MS = 3000;
  let phase = "mouseMoved";
  let acknowledged = false;

  const send = async (event: Record<string, unknown>, timeout: number) => {
    checkCurrent();
    await assertSameDocument(tabId, documentId);
    checkCurrent();
    await sendCommand(tabId, "Input.dispatchMouseEvent", event, checkCurrent, timeout);
    acknowledged = true;
    checkCurrent();
  };

  holdAttach(tabId);

  try {
    await send({ type: "mouseMoved", x, y, modifiers }, MOVE_ACK_MS);
    phase = "primary wheel";
    const started = Date.now();
    await send({ type: "mouseWheel", x, y, deltaX, deltaY, modifiers, pointerType: "mouse" }, ACK_MS);
    const ackMs = Date.now() - started;
    phase = "trailing wheel";
    await send({ type: "mouseWheel", x, y, deltaX: 0, deltaY: 0, modifiers, pointerType: "mouse" }, ACK_MS);
    heldOf(sessionId).pointer = [x, y];

    return { wheeled: true, point: [x, y], ackMs, attempts: 1 };
  } catch (error) {
    const fact = error && typeof error === "object" && "executionFact" in error ? error.executionFact : undefined;
    throw Object.assign(new Error(`wheel ${phase} 未确认完成（${oneLine(error)}）。未重放手势；请先独立观察页面，不得当作未发生重新滚动。`), {
      executionFact: acknowledged || fact === "unknown" ? "unknown" : "not_executed",
    });
  } finally {
    releaseAttachHold(tabId);
  }
}

export async function mouseDown(
  params: {
    button?: MouseButton;
    clickCount?: number;
    point?: [number, number];
    target?: string;
    position?: ElementPosition;
    tabId?: number;
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ down: true; point: [number, number]; button: MouseButton }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  let point = params.point;

  if (!point && params.target) {
    point = (await resolvePointerTarget(tab.id, {
      target: params.target,
      position: params.position,
    })).point;
  }

  if (!point) point = heldOf(sessionId).pointer ?? undefined;

  if (!point) throw notExecuted(new Error("mouseDown 需要 point/target 或先有指针位置；未执行"));
  const button: MouseButton = params.button ?? "left";
  const clickCount = Math.max(1, Math.floor(params.clickCount ?? 1));
  const [x, y] = point;
  const modifiers = modifierMaskFor(sessionId, tab.id);
  heldOf(sessionId).tabId = tab.id;
  heldOf(sessionId).pointer = [x, y];
  heldOf(sessionId).mouseButtons.add(button);

  try {
    await sendCommand(tab.id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: buttonsMaskFor(sessionId),
      clickCount,
      modifiers,
    });
    heldOf(sessionId).pointer = [x, y];

    return { down: true, point: [x, y], button };
  } catch (e) {
    if (!(e && typeof e === "object" && "executionFact" in e && e.executionFact === "unknown")) heldOf(sessionId).mouseButtons.delete(button);
    throw notExecuted(e);
  }
}

export async function mouseUp(
  params: {
    button?: MouseButton;
    clickCount?: number;
    point?: [number, number];
    tabId?: number;
  } = {},
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ up: true; point: [number, number]; button: MouseButton }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  const button: MouseButton = params.button ?? "left";
  const clickCount = Math.max(1, Math.floor(params.clickCount ?? 1));
  const point = params.point ?? heldOf(sessionId).pointer;

  if (!point) throw notExecuted(new Error("mouseUp 需要 point 或先有指针位置；未执行"));
  const [x, y] = point;
  const modifiers = modifierMaskFor(sessionId, tab.id);

  try {
    await sendCommand(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: buttonsMaskFor(sessionId) & ~pressedButtonsMask(button),
      clickCount,
      modifiers,
    });
    heldOf(sessionId).mouseButtons.delete(button);
    heldOf(sessionId).pointer = [x, y];

    return { up: true, point: [x, y], button };
  } catch (e) {
    throw new Error(`mouseUp 可能已送达或释放失败（${oneLine(e)}）。请 snapshot 核验按住状态。`);
  }
}

export async function keyDown(
  params: { key: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ down: true; key: string }> {
  const info = resolveKey(params.key);

  if (!info) throw notExecuted(new Error(`不支持的按键: ${params.key}`));
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  const heldMods = modifierMaskFor(sessionId, tab.id);
  heldOf(sessionId).tabId = tab.id;

  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers: info.modifiers | heldMods,
  };

  heldOf(sessionId).keys.set(params.key, info);

  try {
    await sendCommand(tab.id, "Input.dispatchKeyEvent", {
      type: info.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(info.text !== undefined ? { text: info.text } : {}),
    });

    return { down: true, key: params.key };
  } catch (e) {
    if (!(e && typeof e === "object" && "executionFact" in e && e.executionFact === "unknown")) heldOf(sessionId).keys.delete(params.key);
    throw notExecuted(e);
  }
}

export async function keyUp(
  params: { key: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ up: true; key: string }> {
  const info = resolveKey(params.key) ?? heldOf(sessionId).keys.get(params.key);

  if (!info) throw notExecuted(new Error(`不支持的按键: ${params.key}`));
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  const heldMods = modifierMaskFor(sessionId, tab.id) & ~keyModifierMask(info);

  try {
    await sendCommand(tab.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode,
      modifiers: heldMods,
    });
    heldOf(sessionId).keys.delete(params.key);

    return { up: true, key: params.key };
  } catch (e) {
    throw new Error(`keyUp 可能已送达或释放失败（${oneLine(e)}）。请 snapshot 核验按住状态。`);
  }
}

/** 异常/取消时安全松开本会话按住的键与鼠标键；已派发的释放不报未执行。 */
export async function releaseHeldInputs(
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ releasedKeys: string[]; releasedButtons: MouseButton[] }> {
  const state = heldInputs.get(sessionId);

  if (!state) return { releasedKeys: [], releasedButtons: [] };
  const tabId = state.tabId ?? await resolveOverlayTabId(sessionId);
  const releasedKeys: string[] = [];
  const releasedButtons: MouseButton[] = [];
  const point = state.pointer ?? [0, 0];

  if (tabId != null) {
    for (const [name, info] of [...state.keys.entries()]) {
      try {
        await sendCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
          modifiers: modifierMaskFor(sessionId, tabId) & ~keyModifierMask(info),
        });
        state.keys.delete(name);
        releasedKeys.push(name);
      } catch { /* retain the possible hold; do not claim a confirmed release */ }
    }

    for (const button of [...state.mouseButtons]) {
      try {
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point[0],
          y: point[1],
          button,
          buttons: buttonsMaskFor(sessionId) & ~pressedButtonsMask(button),
          clickCount: 1,
          modifiers: modifierMaskFor(sessionId, tabId),
        });
        state.mouseButtons.delete(button);
        releasedButtons.push(button);
      } catch { /* retain the possible hold; cleanup can be retried explicitly */ }
    }
  } else {
    // No page identity is not proof that a key was released.
  }

  if (state.keys.size || state.mouseButtons.size) throw Object.assign(new Error("INPUT_CLEANUP_UNCONFIRMED: 仍有输入释放未获确认，保留原页清理状态。"), { executionFact: "unknown", releasedKeys, releasedButtons });
  clearHeldRecord(sessionId);

  return { releasedKeys, releasedButtons };
}

/**
 * 原生粘贴：经剪贴板桥写入 text/html → ControlOrMeta+V → 按 changeCount 恢复。
 * 无桥 → BLOCKED。禁止 innerHTML / 合成 paste 事件冒充。
 *
 * 无头 Chromium（UA 含 HeadlessChrome）的 paste 读浏览器内部剪贴板，不读
 * NSPasteboard；系统板写入后须把同一份 text/html 镜像进页面 clipboard。
 * 有头 Chrome 与系统板连通，禁止镜像，以免额外 bump changeCount。
 */
export async function paste(
  params: { content: PasteContent; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ pasted: true; clipboard: ClipboardFinishStatus }> {
  if (!clipboardBridge) {
    throw notExecuted(new Error(PASTE_HOST_BLOCKED));
  }

  const content = normalizePasteContent(params.content);
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);

  const platform = typeof navigator !== "undefined" ? navigator.platform : "MacIntel";
  const chord = pasteChord(platform);
  const { changeCount } = await clipboardBridge.beginTemporary(content);

  try {
    if (await pageUsesIsolatedChromiumClipboard(tab.id)) {
      await mirrorPasteContentToPageClipboard(tab.id, content);
    }

    await pressKey({ key: chord, tabId: tab.id }, sessionId);
    // CDP paste 命令异步读剪贴板；过早 restore 会交出空粘贴。
    await new Promise((r) => setTimeout(r, 120));
  } catch (e) {
    let restoreError: unknown;

    try {
      await clipboardBridge.finish(changeCount);
    } catch (err) {
      restoreError = err;
    }

    if (restoreError) {
      throw new AggregateError(
        [e instanceof Error ? e : new Error(String(e)), restoreError instanceof Error ? restoreError : new Error(String(restoreError))],
        "粘贴动作失败且剪贴板未能恢复",
      );
    }

    throw notExecuted(e);
  }

  const clipboard = await clipboardBridge.finish(changeCount);

  return { pasted: true, clipboard };
}

/** 无头 Chromium 的 UA 含 HeadlessChrome，其 paste 不读系统 NSPasteboard。 */
async function pageUsesIsolatedChromiumClipboard(tabId: number): Promise<boolean> {
  try {
    return await callDom(
      tabId,
      () => /HeadlessChrome/i.test(navigator.userAgent),
      [],
    );
  } catch {
    return false;
  }
}

/** 把桥已写入系统板的同一份内容镜像进页面 Clipboard API（仅无头隔离剪贴板需要）。 */
async function mirrorPasteContentToPageClipboard(
  tabId: number,
  content: { text: string; html?: string },
): Promise<void> {
  await callDom(
    tabId,
    async (text: string, html: string | null) => {
      if (!navigator.clipboard?.write) {
        throw new Error("页面 Clipboard API 不可用，无头 paste 无法镜像");
      }

      const items: Record<string, Blob> = {
        "text/plain": new Blob([text], { type: "text/plain" }),
      };

      if (html != null) {
        items["text/html"] = new Blob([html], { type: "text/html" });
      }

      await navigator.clipboard.write([new ClipboardItem(items)]);
    },
    [content.text, content.html ?? null],
  );
}


type Html5DragResult =
  | { dragged: true; path: "intercept" | "synthetic-data"; effect?: EffectReport }
  | { dragged: false; gap: "no_intercept_payload"; detail: string };

/**
 * HTML5 draggable + DataTransfer：优先 Input.setInterceptDrags + 真实手势取页面 dragstart 载荷，
 * 再 dispatchDragEvent(dragEnter/dragOver/drop)。纯 pointer drag 不算 HTML5 成功。
 */
export async function html5DragAndDrop(
  params: {
    tabId?: number;
    from: DragEndpoint;
    to: DragEndpoint;
    label?: string;
    /** 仅测试桩：显式注入 DragData（绕过页面 dragstart，正式路径勿默认使用）。 */
    syntheticData?: {
      items: Array<{ mimeType: string; data: string; title?: string }>;
      files?: string[];
      dragOperationsMask?: number;
    };
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<Html5DragResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);

  if (!params.from || !params.to || (!params.from.target && !params.from.point) || (!params.to.target && !params.to.point)) {
    throw notExecuted(new Error("html5DragAndDrop 需要 from 与 to；未执行"));
  }

  const tabId = tab.id;
  await maybeActivateTab(tab, sessionId);

  const from = await resolvePointerTarget(tabId, {
    target: params.from.target,
    point: params.from.point,
    position: params.from.position,
  });

  const to = await resolvePointerTarget(tabId, {
    target: params.to.target,
    point: params.to.point,
    position: params.to.position,
  });

  const [sx, sy] = from.point;
  const [tx, ty] = to.point;
  const modifiers = modifierMaskFor(sessionId, tab.id);

  if (params.syntheticData) {
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, modifiers });

    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await sendCommand(tabId, "Input.dispatchDragEvent", {
        type,
        x: tx,
        y: ty,
        data: params.syntheticData,
        modifiers,
      });
    }

    heldOf(sessionId).pointer = [tx, ty];

    return { dragged: true, path: "synthetic-data" };
  }

  let interceptEnabled = false;
  let interceptPayload: Record<string, unknown> | null = null;

  // 参数类型直接取 chrome.debugger.onEvent 的回调签名（外部边界既有类型），下面立刻收窄成具名载荷。
  const onEvent: Parameters<typeof chrome.debugger.onEvent.addListener>[0] = (source, method, eventParams) => {
    if (source.tabId !== tabId) return;

    if (method !== "Input.dragIntercepted") return;
    // SAFETY: Input.dragIntercepted 的事件体就是 CDP 的 DragIntercepted 对象，data 为字符串载荷。
    const data = (eventParams as { data?: unknown } | undefined)?.data;

    if (data && typeof data === "object") interceptPayload = data as Record<string, unknown>;
  };

  try {
    chrome.debugger?.onEvent?.addListener(onEvent);

    try {
      await sendCommand(tabId, "Input.setInterceptDrags", { enabled: true });
      interceptEnabled = true;
    } catch (e) {
      return {
        dragged: false,
        gap: "no_intercept_payload",
        detail: `Input.setInterceptDrags 不可用（${oneLine(e)}）；pointer drag 不能证明 HTML5 DataTransfer`,
      };
    }

    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy, modifiers });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: sx, y: sy, button: "left", buttons: 1, clickCount: 1, modifiers,
    });
    const distance = Math.hypot(tx - sx, ty - sy);
    const steps = Math.min(20, Math.max(4, Math.ceil(distance / 60)));

    for (let i = 1; i <= steps; i++) {
      const mx = Math.round(sx + ((tx - sx) * i) / steps);
      const my = Math.round(sy + ((ty - sy) * i) / steps);
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1, modifiers,
      });

      if (i < steps) await new Promise((r) => setTimeout(r, 12));
    }

    const deadline = Date.now() + 800;

    while (!interceptPayload && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    try {
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: tx, y: ty, button: "left", buttons: 0, clickCount: 1, modifiers,
      });
    } catch { /* 原拦截结果优先 */ }

    if (!interceptPayload || !Array.isArray((interceptPayload as { items?: unknown }).items)) {
      return {
        dragged: false,
        gap: "no_intercept_payload",
        detail: "未收到 Input.dragIntercepted 有效载荷；不能用合成 DOM 事件冒充 HTML5 投放",
      };
    }

    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await sendCommand(tabId, "Input.dispatchDragEvent", {
        type,
        x: tx,
        y: ty,
        data: interceptPayload,
        modifiers,
      });
    }

    heldOf(sessionId).pointer = [tx, ty];

    return { dragged: true, path: "intercept" };
  } finally {
    try {
      chrome.debugger?.onEvent?.removeListener(onEvent);
    } catch { /* */ }

    if (interceptEnabled) {
      try {
        await sendCommand(tabId, "Input.setInterceptDrags", { enabled: false });
      } catch { /* */ }
    }
  }
}

export async function scroll(
  params: { dy?: number; toBottom?: boolean; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ atBottom: boolean }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await ensureDomOps(tab.id);

  if (params.toBottom) {
    const res = await callDom(
      tab.id,
      (maxSteps: number) => {
        const dom = window.__sideagent?.dom;

        if (!dom) throw new Error("domops 未注入");

        return dom.scrollToBottom(maxSteps);
      },
      [20],
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
    [params.dy ?? null],
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
    label?: string;
    actions?: unknown;
    style?: "rect" | "sketch";
    motion?: "grow" | "boil";
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ marked: true }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const observedDocument = await assertObservedDocument(tab.id, sessionId);
  const tabId = tab.id;
  const cid = cursorId(sessionId);

  // 与 click 同样的解析策略：AX 快照 ref 走 CDP，其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;
  let rect: DomRect | undefined;

  if (backendNodeId !== undefined) {
    try {
      rect = await rectOfBackendNode(tabId, backendNodeId, true);
    } catch (e) {
      if (!isDebuggerUnavailable(e)) {
        throw notExecuted(new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`));
      }
    }
  }

  if (!rect) {
    await ensureDomOps(tabId);

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
      [params.target],
    );

    if (!res || !res.ok) {
      throw new Error(res?.ok === false ? res.error : `未找到目标元素：${params.target}`);
    }

    if (!res.rect || typeof res.rect.x !== "number") {
      throw new Error(`未找到目标元素：${params.target}`);
    }

    rect = res.rect;
  }

  await ensureCursor(tabId);
  const actions = resolveImplicitMarkActions(params.label, params.actions) ?? null;
  const motion = await getMarkMotion();
  const style = params.style ?? "sketch";
  await assertSameDocument(tabId, observedDocument);

  if (backendNodeId !== undefined) {
    const contextId = await cursorContext(tabId);
    await assertSameDocument(tabId, observedDocument);
    await callOnBackendNode(tabId, backendNodeId, `function(label,target,id,actions,options) {
      const rect = (${observedNodeRect.toString()}).call(this,true);
      window.__sideagent.cursor.for(id).mark(rect,label ?? undefined,target,actions ?? undefined,options,this);
    }`, [params.label ?? null,params.target,cid,actions,{style,motion}], contextId);

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
    [rect, params.label ?? null, params.target, cid, actions, { style, motion }],
  );

  return { marked: true };
}

/** clear_marks 工具：清除全部 mark 标注。受限页面本来就画不上标注，静默成功。 */
export async function clearMarks(sessionId: string = LEAD_SESSION_ID, tabId?: number): Promise<{ cleared: true }> {
  const tab = await resolveWorkingTab(tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  try {
    await ensureCursor(tab.id);
    await callDom(tab.id, () => window.__sideagent?.cursor?.clearMarks?.(), []);
  } catch {
    /* 页面禁止注入（如 chrome://）时没有标注可清，静默 */
  }

  return { cleared: true };
}
