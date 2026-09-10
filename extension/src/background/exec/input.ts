import {assertObservedDocument, assertSameDocument} from "../observation-document.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { documentPoint, pointsOnTab } from "../../shared/cursor-trail.js";
import { recordTrailPoint, trailForReplay } from "./trail.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, maybeActivateTab, resolveWorkingTab } from "../state.js";
import { resolveKey } from "../../shared/keymap.js";
import { isAxRef } from "../axstate.js";
import { observedNodeRect } from "../observed-node-rect.js";
import { cursorContext } from "../cursor-context.js";
import { oneLine } from "../util.js";
import {
  confirmLabelForDestructive,
  isDestructiveLabel,
  parseMarkActions,
  resolveImplicitMarkActions,
} from "../../shared/mark-actions.js";
import { HeldClicks } from "../../shared/held-clicks.js";
import { getMarkMotion } from "../mode.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { beginEffect, collectEffect } from "./effect.js";
import { switchTab } from "./tabs.js";
import type { EffectReport } from "../../../../shared/effect.js";

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** "@N" → ref 号；非 @N 形式返回 null。 */
function parseRef(target: string): number | null {
  if (!target.startsWith("@")) return null;
  const n = Number(target.slice(1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 把 backendDOMNodeId 解析成页面内元素并执行函数（CDP Runtime.callFunctionOn）。 */
async function callOnBackendNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args?: unknown[],
  executionContextId?: number,
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
    backendNodeId,
    ...(executionContextId !== undefined ? {executionContextId} : {}),
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");
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

/** AX ref → 元素中心视口坐标（scrollIntoView + getBoundingClientRect，与 domops 同语义）。 */
async function centerOfBackendNode(tabId: number, backendNodeId: number): Promise<[number, number]> {
  const rect = await rectOfBackendNode(tabId, backendNodeId);
  return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
}

/** AX ref → 填充（原生 value setter + input/change 事件，与 domops fill 同逻辑）。 */
async function fillBackendNode(tabId: number, backendNodeId: number, value: string): Promise<void> {
  await callOnBackendNode<unknown>(
    tabId,
    backendNodeId,
    `function(v) {
      const el = this;
      el.focus();
      const tag = el.tagName.toLowerCase();
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
        el.textContent = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      throw new Error("元素不可填充（非 input/textarea/contenteditable）");
    }`,
    [value],
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
): Promise<Awaited<Result>> {
  const results = await chrome.scripting.executeScript<Args, Result>({
    target: { tabId },
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
  target?: string;
  point?: [number, number];
  label?: string;
};

type ClickResult = { clicked: true; effect?: EffectReport; newTab?: { tabId: number; url?: string } } | { clicked: false; held: true };

/** held/arm 台账抽成纯数据层（shared/held-clicks.ts），决策逻辑可单测。 */
const heldClicks = new HeldClicks<ClickParams>(LEAD_SESSION_ID);

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

const controlBannerTabs = new Set<number>();

export type ControlBannerView = {
  status?: string;
  sub?: string;
  action?: string;
  actionEnabled?: boolean;
  members?: Array<{ id: string; initial: string; color: string }>;
};

async function paintControlBanner(tabId: number, show: boolean, view?: ControlBannerView | null): Promise<void> {
  try {
    await ensureCursor(tabId);
    await callDom(
      tabId,
      (on: boolean, banner: ControlBannerView | null) => {
        const c = window.__sideagent?.cursor;
        if (on) c?.showUserControl?.(banner ?? undefined);
        else c?.hideUserControl?.();
      },
      [show, show ? (view ?? null) : null],
    );
    if (show) controlBannerTabs.add(tabId);
    else controlBannerTabs.delete(tabId);
  } catch {
    controlBannerTabs.delete(tabId);
  }
}

export async function showUserControlBanner(
  tabId?: number,
  sessionId: string = LEAD_SESSION_ID,
  view?: ControlBannerView | null,
): Promise<void> {
  const ids = new Set<number>();
  if (tabId != null) {
    ids.add(tabId);
    await Promise.all([...ids].map((id) => paintControlBanner(id, true, view)));
    return;
  }
  const fallback = await resolveOverlayTabId(sessionId);
  if (fallback != null) ids.add(fallback);
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id != null) ids.add(active.id);
  } catch {
    /* 无活动标签 */
  }
  await Promise.all([...ids].map((id) => paintControlBanner(id, true, view)));
}

export async function showTeamControlBanners(tabIds: Iterable<number>, view?: ControlBannerView | null): Promise<void> {
  const ids = new Set<number>();
  for (const id of tabIds) {
    if (typeof id === "number") ids.add(id);
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id != null) ids.add(active.id);
  } catch {
    /* 无活动标签 */
  }
  await Promise.all([...ids].map((id) => paintControlBanner(id, true, view)));
}

export async function hideCursorsForSessions(sessionIds: Iterable<string>): Promise<void> {
  await Promise.all([...sessionIds].map((id) => hideCursors(id)));
}

export async function hideUserControlBanners(tabId?: number): Promise<void> {
  const ids = tabId == null ? new Set(controlBannerTabs) : new Set([tabId]);
  if (tabId == null) controlBannerTabs.clear();
  else controlBannerTabs.delete(tabId);
  await Promise.all([...ids].map((id) => paintControlBanner(id, false)));
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
    return { clicked: false };
  }
  if (decision.kind === "armOnce") {
    // 模型自绘 mark 路径：pending 无记录，点「确认」直接 arm，模型重试 click 一次通过
    return { clicked: false };
  }
  // 确认：先松开拿住态，再由同一只手在目标点播波纹并真实派发
  await releaseHold(decision.sessionId);
  try {
    await click(decision.params, decision.sessionId);
    return { clicked: true };
  } finally {
    heldClicks.drop(decision.sessionId);
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
        if (!targetRect || typeof targetRect.x !== "number") {
          throw new Error("无法获取元素位置");
        }
        if (!point) {
          point = [Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2)];
        }
        resolvedViaCdp = true;
      } catch (e) {
        if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
          throw new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`);
        }
        // debugger 不可用：落到 domops 路径（注意此时 @N 依赖 DOM 快照的 refs，
        // 若上次快照是 AX 版会解析不到——属边缘情况，让 domops 报「已失效」即可）
      }
    }
    if (!resolvedViaCdp && !point) {
      await ensureDomOps(tabId);
      const res = await callDom(
        tabId,
        (t: string): { ok: true; rect: DomRect } | { ok: false; error: string } => {
          const dom = window.__sideagent?.dom;
          if (!dom) return { ok: false, error: "domops 未注入" };
          try {
            return { ok: true, rect: dom.rectOf(t) };
          } catch (e: any) {
            return { ok: false, error: e?.message ?? String(e) };
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
      targetRect = res.rect;
      point = [Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2)];
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
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
        const msg = oneLine(e);
        if (/已失效|覆盖|可命中|不可见/.test(msg)) throw new Error(msg);
        throw new Error(
          `ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${msg}）`,
        );
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
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
        const msg = oneLine(e);
        if (/已失效|覆盖|可命中|不可见/.test(msg)) throw new Error(msg);
        throw new Error(
          `ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${msg}）`,
        );
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
  const tab = await resolveWorkingTab(undefined, sessionId);
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
  const tab = await resolveWorkingTab(undefined, sessionId);
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
    heldClicks.hold(sessionId, { ...params });
    await maybeActivateTab(tab, sessionId);
    const confirmLabel = confirmLabelForDestructive(name);
    const actions = [
      { id: "confirm" as const, label: confirmLabel },
      { id: "cancel" as const, label: "取消" },
    ];
    // C 案：框（mark）留作视觉锚；键不在框外——cursor.mark 带 actions 时
    // 光标自己飞到目标拿住，双键长在名牌上（与模型自绘 mark 同一形态，只有一套键）。
    try {
      if (params.target) {
        await mark({ target: params.target, label: "待确认", actions }, sessionId);
      } else if (targetRect) {
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
          [targetRect, "待确认", cid, actions],
        );
      } else if (point) {
        // 只有坐标没有元素：画不出框，手仍飞过去拿住（锚点取该位置的元素）
        await ensureCursor(tabId);
        await callDom(
          tabId,
          (x: number, y: number, id: string, a: Array<{ id: "confirm" | "cancel"; label: string }>) => {
            const cursor = window.__sideagent?.cursor?.for(id);
            if (!cursor?.hold) throw new Error("cursor 未注入");
            cursor.hold(x, y, a);
          },
          [point[0], point[1], cid, actions],
        );
      }
    } catch {
      /* 画不出标注也先不点：侧栏打「确认」仍可放行 */
    }
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

  const actionId = await beginCursorAction(tabId, cid, "click", target, name);
  try {
    // 目标边框与浅弧移动并行；不再为高亮和预播放波纹额外等待。
    await cursorMove(tabId, x, y, cid);

    if (target) {
      const confirmed = await confirmPointerTarget(tabId, target);
      x = confirmed.point[0];
      y = confirmed.point[1];
      if (x !== point[0] || y !== point[1]) {
        await cursorMove(tabId, x, y, cid);
      }
    }

    let cdpMouseMoved = false;
    let cdpMousePressed = false;
    let effect: EffectReport | undefined;
    try {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      cdpMouseMoved = true;
      // 基线与命中核对并行：60ms 的页面活跃度采样不额外压在一次点击的串行等待上。
      const effectPending = beginEffect(tabId, { point: [x, y] });
      // 真实 mouseMoved 可能触发 mouseenter 把目标移走、原位露出 trap。
      // 按下前只核对当前命中与原目标身份；变化则拒绝，不追逐新坐标。
      if (target) {
        await hitTestPointerTarget(tabId, target, x, y);
      } else {
        await callPointGuard(tabId, x, y, "confirm");
      }
      const effectToken = await effectPending;
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      cdpMousePressed = true;
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      effect = await collectEffect(tabId, effectToken);
    } catch (e) {
      if (cdpMousePressed) {
        throw new Error(
          `点击可能已送达，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }
      if (cdpMouseMoved) {
        if (isPrePressTargetError(e)) throw e;
        throw new Error(
          `点击是否送达无法确认，后续 CDP 返回异常，未再次点击（${oneLine(e)}）。请 snapshot 核验当前页面，不要当作未执行而重试。`,
        );
      }
      // 尚未向页面派发任何 CDP 输入（如 DevTools 占用）时，才允许 DOM 回退一次
      if (target) {
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

export async function fill(
  params: { target: string; value: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ filled: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  await maybeActivateTab(tab, sessionId);

  // AX 快照的 @N（ref 即 backendDOMNodeId）走 CDP（同 domops fill 逻辑）；其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  // 操作前在 scrollIntoView 之后取目标包围盒，动作边框持续到操作返回。
  let targetRect: DomRect | undefined;
  if (backendNodeId !== undefined) {
    try {
      targetRect = await rectOfBackendNode(tabId, backendNodeId);
    } catch (e) {
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
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
        (t: string): { ok: true; rect: DomRect } | { ok: false; error: string } => {
          const dom = window.__sideagent?.dom;
          if (!dom) return { ok: false, error: "domops 未注入" };
          try {
            return { ok: true, rect: dom.rectOf(t) };
          } catch (e: any) {
            return { ok: false, error: e?.message ?? String(e) };
          }
        },
        [params.target],
      );
      if (res?.ok && res.rect && typeof res.rect.x === "number") {
        targetRect = res.rect;
      } else if (backendNodeId === undefined) {
        throw new Error(res?.ok === false ? res.error : `未找到目标元素：${params.target}`);
      }
    } catch (e) {
      if (backendNodeId === undefined) {
        throw e;
      }
    }
  }

  const actionId = await beginCursorAction(tabId, cid, "fill", params.target);
  try {
    if (targetRect) {
      await cursorMove(tabId, Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2), cid);
    }

    // 2. 真实填充操作
    if (backendNodeId !== undefined) {
      try {
        await fillBackendNode(tabId, backendNodeId, params.value);
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
        if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
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

export async function typeText(
  params: { text: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ typed: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);
  await sendCommand(tab.id, "Input.insertText", { text: params.text });
  return { typed: true };
}

export async function pressKey(
  params: { key: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ pressed: true }> {
  const info = resolveKey(params.key);
  if (!info) throw new Error(`不支持的按键: ${params.key}`);
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  await assertObservedDocument(tab.id, sessionId);
  await maybeActivateTab(tab, sessionId);

  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers: info.modifiers,
  };
  await sendCommand(tab.id, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base,
    ...(info.text !== undefined ? { text: info.text } : {}),
  });
  await sendCommand(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { pressed: true };
}

export async function scroll(
  params: { dy?: number; toBottom?: boolean },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ atBottom: boolean }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
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
    target: string;
    label?: string;
    actions?: unknown;
    style?: "rect" | "sketch";
    motion?: "grow" | "boil";
  },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ marked: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
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
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
        throw new Error(`ref @${ref} 已失效，操作未执行。请重新 snapshot，确认当前目标并使用新的 ref，不要重试旧 ref（${oneLine(e)}）`);
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
export async function clearMarks(sessionId: string = LEAD_SESSION_ID): Promise<{ cleared: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  try {
    await ensureCursor(tab.id);
    await callDom(tab.id, () => window.__sideagent?.cursor?.clearMarks?.(), []);
  } catch {
    /* 页面禁止注入（如 chrome://）时没有标注可清，静默 */
  }
  return { cleared: true };
}
