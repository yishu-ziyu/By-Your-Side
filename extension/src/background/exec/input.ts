import { LEAD_SESSION_ID, isLeadSession } from "../../../../shared/protocol.js";
import { documentPoint, pointsOnTab } from "../../shared/cursor-trail.js";
import { recordTrailPoint, trailForReplay } from "./trail.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, maybeActivateTab, resolveWorkingTab } from "../state.js";
import { resolveKey } from "../../shared/keymap.js";
import { isAxRef } from "../axstate.js";
import { oneLine } from "../util.js";
import {
  confirmLabelForDestructive,
  isDestructiveLabel,
  parseMarkActions,
} from "../../shared/mark-actions.js";

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
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
    backendNodeId,
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
async function rectOfBackendNode(tabId: number, backendNodeId: number): Promise<DomRect> {
  const rect = await callOnBackendNode<DomRect | undefined>(
    tabId,
    backendNodeId,
    `function() {
      const el = this;
      if (typeof el.scrollIntoViewIfNeeded === "function") el.scrollIntoViewIfNeeded({ block: "center", inline: "center" });
      else el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }`,
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

async function ensureCursor(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-cursor.js"],
    world: "ISOLATED",
  });
}

/** 在页面 ISOLATED world 里执行 func 并取回结果。 */
async function callDom<Args extends unknown[], Result>(
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
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId;
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
  } catch {
    /* 页面禁止注入则跳过可视化 */
  }
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

export async function stopTrailReplay(): Promise<void> {
  const trail = trailForReplay();
  if (!trail) return;
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

async function cursorPark(tabId: number, id: string): Promise<void> {
  try {
    await callDom(
      tabId,
      (cid: string) => {
        window.__sideagent?.cursor?.for(cid)?.park?.();
      },
      [id],
    );
  } catch {
    /* 同上 */
  }
}

type ClickParams = {
  target?: string;
  point?: [number, number];
  label?: string;
};

type ClickResult = { clicked: true } | { clicked: false; held: true };

const pendingBySession = new Map<string, ClickParams>();
const armedSessions = new Set<string>();

export function armDestructiveClick(sessionId: string = LEAD_SESSION_ID): void {
  armedSessions.add(sessionId);
}

export function hasPendingDestructiveClick(sessionId: string = LEAD_SESSION_ID): boolean {
  return pendingBySession.has(sessionId);
}

export function dropPendingClicks(sessionId: string = LEAD_SESSION_ID): void {
  pendingBySession.delete(sessionId);
  armedSessions.delete(sessionId);
}

export function dropAllPendingClicks(): void {
  pendingBySession.clear();
  armedSessions.clear();
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
  if (tabId != null) ids.add(tabId);
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
  const ids = new Set(controlBannerTabs);
  if (tabId != null) ids.add(tabId);
  controlBannerTabs.clear();
  await Promise.all([...ids].map((id) => paintControlBanner(id, false)));
}

function pendingSession(preferred: string): string | undefined {
  if (pendingBySession.has(preferred)) return preferred;
  if (pendingBySession.has(LEAD_SESSION_ID)) return LEAD_SESSION_ID;
  return pendingBySession.keys().next().value;
}

export async function resolveHeldClick(
  action: "confirm" | "cancel",
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ clicked: boolean }> {
  const sid = pendingSession(sessionId);
  if (!sid) {
    if (action === "cancel") {
      try {
        await clearMarks(sessionId);
      } catch {
        /* 没有标注可清 */
      }
    }
    return { clicked: false };
  }
  const pending = pendingBySession.get(sid);
  pendingBySession.delete(sid);
  if (action === "cancel") {
    armedSessions.delete(sid);
    try {
      await clearMarks(sid);
    } catch {
      /* 没有标注可清 */
    }
    return { clicked: false };
  }
  if (!pending) return { clicked: false };
  armedSessions.add(sid);
  try {
    await click(pending, sid);
    return { clicked: true };
  } finally {
    armedSessions.delete(sid);
    pendingBySession.delete(sid);
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

export async function click(
  params: ClickParams,
  sessionId: string = LEAD_SESSION_ID,
): Promise<ClickResult> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  const target = params.target;
  let point = params.point;
  if (!point && !target) throw new Error("click 需要 target 或 point 参数");

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
        if (!point) {
          point = [Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2)];
        }
        resolvedViaCdp = true;
      } catch (e) {
        if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
          throw new Error(`ref @${ref} 已失效，请重新 snapshot（${oneLine(e)}）`);
        }
        // debugger 不可用：落到 domops 路径（注意此时 @N 依赖 DOM 快照的 refs，
        // 若上次快照是 AX 版会解析不到——属边缘情况，让 domops 报「已失效」即可）
      }
    }
    if (!resolvedViaCdp && !point) {
      await ensureDomOps(tabId);
      targetRect = await callDom(
        tabId,
        (t: string): DomRect => {
          const dom = window.__sideagent?.dom;
          if (!dom) throw new Error("domops 未注入");
          return dom.rectOf(t);
        },
        [target],
      );
      point = [Math.round(targetRect.x + targetRect.width / 2), Math.round(targetRect.y + targetRect.height / 2)];
    }
  }

  const name = await nameOfClickTarget(tabId, params);
  const wasArmed = armedSessions.has(sessionId);
  if (isDestructiveLabel(name) && !wasArmed) {
    pendingBySession.set(sessionId, { ...params });
    await maybeActivateTab(tab, sessionId);
    const confirmLabel = confirmLabelForDestructive(name);
    const actions = [
      { id: "confirm" as const, label: confirmLabel },
      { id: "cancel" as const, label: "取消" },
    ];
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
      }
    } catch {
      /* 画不出按钮也先不点：侧栏打「确认」仍可放行 */
    }
    return { clicked: false, held: true };
  }
  if (isDestructiveLabel(name) && wasArmed) {
    armedSessions.delete(sessionId);
    pendingBySession.delete(sessionId);
  }

  await maybeActivateTab(tab, sessionId);

  // 1. 操作前元素高亮：如果解析到了目标元素包围盒，先展示呼吸高亮框（静默兜底）
  if (targetRect) {
    try {
      await ensureCursor(tabId);
      await callDom(
        tabId,
        (r: DomRect, id: string) => window.__sideagent?.cursor?.for(id)?.highlight(r),
        [targetRect, cid],
      );
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // 页面禁止注入（如 chrome:// 页面）等场景静默跳过
    }
  }

  // 2. 虚拟鼠标：沿浅弧飞到目标、播点击波纹，再真实派发。飞完才点，避免波纹落在半路。
  {
    const [vx, vy] = point!;
    await cursorMove(tabId, vx, vy, cid);
    try {
      await callDom(
        tabId,
        (x: number, y: number, id: string) => window.__sideagent?.cursor?.for(id)?.click(x, y),
        [vx, vy, cid],
      );
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // 页面禁止注入（如 chrome:// 页面）等场景：跳过可视化
    }
  }

  try {
    const [x, y] = point!;
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } catch (e) {
    // debugger 不可用（如被 DevTools 占用）时退到 domops 合成事件
    if (target) {
      await ensureDomOps(tabId);
      await callDom(
        tabId,
        (t: string) => {
          const dom = window.__sideagent?.dom;
          if (!dom) throw new Error("domops 未注入");
          return dom.click(t);
        },
        [target],
      );
      if (point) await recordCursorTrail(tabId, sessionId, point[0], point[1], true);
      return { clicked: true };
    }
    throw e;
  }
  if (point) await recordCursorTrail(tabId, sessionId, point[0], point[1], true);
  return { clicked: true };
}

export async function fill(
  params: { target: string; value: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ filled: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  const cid = cursorId(sessionId);
  await maybeActivateTab(tab, sessionId);

  // AX 快照的 @N（ref 即 backendDOMNodeId）走 CDP（同 domops fill 逻辑）；其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;

  // 1. 操作前元素高亮：必须在 scrollIntoView 之后取包围盒并展示呼吸框（静默兜底）
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
      targetRect = await callDom(
        tabId,
        (t: string): DomRect => {
          const dom = window.__sideagent?.dom;
          if (!dom) throw new Error("domops 未注入");
          return dom.rectOf(t);
        },
        [params.target],
      );
    } catch (e) {
      if (backendNodeId === undefined) {
        throw e;
      }
    }
  }

  if (targetRect) {
    try {
      await ensureCursor(tabId);
      await callDom(
        tabId,
        (r: DomRect, id: string) => window.__sideagent?.cursor?.for(id)?.highlight(r),
        [targetRect, cid],
      );
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // 页面禁止注入等场景静默跳过
    }
    const cx = Math.round(targetRect.x + targetRect.width / 2);
    const cy = Math.round(targetRect.y + targetRect.height / 2);
    await cursorMove(tabId, cx, cy, cid);
  }

  // 2. 真实填充操作
  if (backendNodeId !== undefined) {
    try {
      await fillBackendNode(tabId, backendNodeId, params.value);
      if (targetRect) {
        await cursorPark(tabId, cid);
        await recordCursorTrail(
          tabId,
          sessionId,
          Math.round(targetRect.x + targetRect.width / 2),
          Math.round(targetRect.y + targetRect.height / 2),
          false,
        );
      }
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
    await cursorPark(tabId, cid);
    await recordCursorTrail(
      tabId,
      sessionId,
      Math.round(targetRect.x + targetRect.width / 2),
      Math.round(targetRect.y + targetRect.height / 2),
      false,
    );
  }
  return { filled: true };
}

export async function typeText(
  params: { text: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ typed: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
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
 * target 定位串与 click 同语义；注入失败如实报错（标注是显式动作，需要反馈）。
 */
export async function mark(
  params: { target: string; label?: string; actions?: unknown },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ marked: true }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  const cid = cursorId(sessionId);

  // 与 click 同样的解析策略：AX 快照 ref 走 CDP，其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;
  let rect: DomRect | undefined;
  if (backendNodeId !== undefined) {
    try {
      rect = await rectOfBackendNode(tabId, backendNodeId);
    } catch (e) {
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
        throw new Error(`ref @${ref} 已失效，请重新 snapshot（${oneLine(e)}）`);
      }
    }
  }
  if (!rect) {
    await ensureDomOps(tabId);
    rect = await callDom(
      tabId,
      (t: string): DomRect => {
        const dom = window.__sideagent?.dom;
        if (!dom) throw new Error("domops 未注入");
        return dom.rectOf(t);
      },
      [params.target],
    );
  }

  await ensureCursor(tabId);
  const actions = parseMarkActions(params.actions) ?? null;
  await callDom(
    tabId,
    (
      r: DomRect,
      l: string | null,
      t: string,
      id: string,
      a: Array<{ id: "confirm" | "cancel"; label: string }> | null,
    ) => {
      const cursor = window.__sideagent?.cursor?.for(id);
      if (!cursor?.mark) throw new Error("cursor 未注入");
      cursor.mark(r, l ?? undefined, t, a ?? undefined);
    },
    [rect, params.label ?? null, params.target, cid, actions],
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
