/**
 * Agent 虚拟鼠标 overlay content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.cursor = { move, click, hold, releaseHold, hide, highlight, mark, clearMarks, for(id) }。
 * mark 标注挂在独立的 absolute host（文档坐标）。window 滚动靠文档坐标天然跟随；
 * 内部滚动容器不会改 window.scroll，必须在 scroll 捕获期按锚定元素的最新
 * getBoundingClientRect 重算。resize / visualViewport 同路径重算 mark 与拿住态光标；
 * 高亮只在 viewport 尺寸变化时收起（滚动不拆瞬时层）。
 * 就地确认（C 案）：危险 click 被拦或 mark 带 actions 时，光标飞到目标拿住（hold），
 * 持久按住不 park，名牌保持成员色并内嵌「确认红 / 取消灰」双键；松开走 releaseHold。
 * 默认实例（名牌 "SideAgent"）供单任务使用；for(id) 返回实例专属光标（名册上的人），
 * 为多任务并行准备的渲染层——每个并行 Agent 一个名字和颜色。
 *
 * shadow DOM（closed）隔离页面样式；host pointer-events:none + 最高 z-index，不干扰页面交互。
 * 坐标均为视口坐标系（与 Input.dispatchMouseEvent / getBoundingClientRect 一致）。
 *
 * 视觉参考：tldraw 协作光标（彩色填充 + 白描边 + 深色外晕 + 名牌 pill）、ChatGPT Agent（点击波纹）。
 * 轨迹：浅弧（ghost-cursor 一侧弧去掉随机）+ Fitts 时长 + easeInOutCubic。
 * 闲着停角落，要点再飞过去；不 3 秒隐掉。
 * 箭头形状取自 lucide MousePointer2（ISC）。
 *
 * 生命周期：MV3 扩展 reload 会销毁 isolated world 但留下 DOM host。启动时若本 world
 * 还没有 cursor API，按 data-sideagent-overlay 清掉旧 host 再创建。
 */
import { isMarkActionId, parseMarkActions, resolveImplicitMarkActions } from "../shared/mark-actions.js";
import { markLabelPlacement } from "../shared/mark-label.js";
import type { MarkAction } from "../../../shared/protocol.js";
import { cursorColor, LEAD_CURSOR_ID } from "../shared/palette.js";
import { displayNameFor } from "../../../shared/cast.js";
import { cursorLabelPosition } from "../shared/cursor-label.js";
import {
  CURSOR_ARROW_PATH,
  CURSOR_STROKE_HALO,
  CURSOR_STROKE_WHITE,
  CURSOR_SVG_SIZE,
  CURSOR_TIP,
} from "../shared/cursor-visual.js";
import {
  PARK_AFTER_MS,
  easeInOutCubic,
  flightMs,
  pointOnArc,
  restOnRight,
  restPoint,
} from "../shared/cursor-path.js";
import {
  HIGHLIGHT_PAD,
  MARK_PAD,
  OVERLAY_ATTR,
  OVERLAY_KIND_CONTROL,
  OVERLAY_KIND_CURSOR,
  OVERLAY_KIND_MARKS,
  highlightBounds,
  sweepStaleOverlayHosts,
  viewportRectToDocumentBox,
} from "../shared/overlay.js";
import { roughArrow, roughEllipse } from "../shared/rough/index.js";

(function () {
  const ns = (window.__sideagent ??= {});
  // 同一 world 重复注入：保留现有实例。新 world（扩展 reload）先清旧 DOM 再挂。
  if (!ns.cursor) sweepStaleOverlayHosts(document);
  if (ns.cursor) return;

  const SCALE = CURSOR_SVG_SIZE / 24;
  const DEFAULT_ID = LEAD_CURSOR_ID;
  const DEFAULT_LABEL = "By Your Side";

  /** 状态文案与颜色是页面侧的唯一来源，background 只给状态名与目标标签页。 */
  const STATUS_COPY: Record<CursorStatusState, { text: string; sub?: string; color: string; clock?: boolean; autoHideMs?: number }> = {
    waiting: { text: "正在等模型响应", color: "#f59e0b", clock: true },
    reading: { text: "正在读这个页面", color: "#2f6fed" },
    done: { text: "完成", color: "#16a34a", autoHideMs: 1500 },
    failed: { text: "这一步没做成", sub: "可以让我重试", color: "#e2554f" },
  };

  interface Instance {
    el: HTMLDivElement;
    color: string;
    visible: boolean;
    restIndex: number;
    pos: { x: number; y: number };
    resting: boolean;
    raf?: number;
    parkTimer?: ReturnType<typeof setTimeout>;
    pressTimer?: ReturnType<typeof setTimeout>;
    replayTimer?: ReturnType<typeof setTimeout>;
    replayGen?: number;
    highlightEl?: HTMLDivElement;
    action?: { id: string; kind: "click" | "fill" | "hover"; phase: "active" | "done" | "failed" | "unknown"; anchor?: Element; rect?: SideAgentRect; name: string; arrived?: boolean };
    labelSize?: { width: number; height: number };
    name: string;
    /** 状态层：一轮任务里"在等 / 在读 / 完成 / 失败"。动作名牌优先于它显示。 */
    status?: CursorStatus;
    /** 拿住态：就地确认期间光标按住目标不放，名牌变双键；scroll/resize 按 anchor 重定位 */
    hold?: { point: { x: number; y: number }; target?: string; anchor: Element | null; name: string; mark?: HTMLDivElement };
  }

  type CursorStatusState = "waiting" | "reading" | "done" | "failed";

  interface CursorStatus {
    state: CursorStatusState;
    text: string;
    /** 第二行：clock 走秒数（等待），否则用 detail / 默认文案 / 成员名 */
    detail: string;
    sub: string;
    clock: boolean;
    since: number;
    autoHideMs?: number;
    tick?: ReturnType<typeof setInterval>;
    clearTimer?: ReturnType<typeof setTimeout>;
  }

  interface CursorStatusView {
    state: CursorStatusState;
    text?: string;
    detail?: string;
    autoHideMs?: number;
  }

  interface MarkOptions {
    style?: "rect" | "sketch";
    motion?: "grow" | "boil";
    seed?: number;
  }

  interface LiveMark {
    el: HTMLDivElement;
    anchor: Element | null;
    observedNode?: Node;
    target?: string;
    pad: number;
    label?: string;
    options?: MarkOptions;
    seed?: number;
  }

  let defaultMarkOptions: MarkOptions = { style: "rect", motion: "grow" };

  let host: HTMLDivElement | null = null;
  let marksHost: HTMLDivElement | null = null;
  let controlHost: HTMLDivElement | null = null;
  let controlBar: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let highlightLayer: HTMLDivElement | null = null;
  let rippleLayer: HTMLDivElement | null = null;
  let marksLayer: HTMLDivElement | null = null;
  let viewportHooked = false;
  const instances = new Map<string, Instance>();
  const liveMarks: LiveMark[] = [];
  let actionFrame: number | undefined;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function ensureDom(): void {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_CURSOR);
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: absolute; top: 0; left: 0;
        transition: opacity 160ms ease;
        will-change: transform;
      }
      .cursor.hidden { opacity: 0; }
      .cursor.rest { opacity: .86; }
      .cursor.rest .label { opacity: 0; }
      .cursor.flip .label { left: auto; right: 18px; }
      .svg-wrap {
        position: absolute; left: 0; top: 0;
        transition: transform 130ms ease;
        transform-origin: ${(CURSOR_TIP.x * SCALE).toFixed(1)}px ${(CURSOR_TIP.y * SCALE).toFixed(1)}px;
      }
      .cursor.pressing .svg-wrap { transform: scale(.8); }
      .cursor svg {
        position: absolute; display: block; overflow: visible;
        left: ${(-CURSOR_TIP.x * SCALE).toFixed(1)}px; top: ${(-CURSOR_TIP.y * SCALE).toFixed(1)}px;
        filter: drop-shadow(0 0 1px #fff) drop-shadow(0 2px 6px rgba(15,23,42,.55));
      }
      .cursor path.fill { fill: var(--c); }
      .cursor path.halo { fill: none; }
      .label {
        position: absolute; left: 22px; top: 24px;
        padding: 2px 9px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 12px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 0 0 1px rgba(255,255,255,.7), 0 2px 8px rgba(15,23,42,.35);
        text-shadow: 0 1px 1px rgba(15,23,42,.35);
        transition: opacity 160ms ease;
        pointer-events: none;
      }
      .cursor.acting .label {
        background: #172033; color: #fff; border-left: 3px solid var(--c);
        padding: 4px 8px; border-radius: 10px;
        width: max-content; max-width: min(260px, calc(100vw - 16px)); box-sizing: border-box;
        font-size: 11px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere;
        text-shadow: none; opacity: 1;
      }
      .action-text { display: block; }
      .agent-name { display: block; color: #d5dbea; font-size: 9.5px; font-weight: 500; }
      /* 状态层：等待 / 读页面 / 完成 / 失败。与动作名牌同一块，左侧色条按状态上色 */
      .cursor.stating .label {
        background: #172033; color: #fff; border-left: 3px solid var(--s, #2f6fed);
        padding: 4px 8px; border-radius: 10px;
        width: max-content; max-width: min(260px, calc(100vw - 16px)); box-sizing: border-box;
        font-size: 11px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere;
        text-shadow: none; opacity: 1;
      }
      .cursor.rest.stating .label { opacity: 1; }
      /* 拿住：名牌保持成员色，内嵌确认红 / 取消灰双键（C 案） */
      .cursor.holding .label {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 4px; pointer-events: auto;
        text-shadow: none;
      }
      .hold-action {
        pointer-events: auto; cursor: pointer; border: 0; border-radius: 999px;
        padding: 2px 10px;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
      }
      .hold-action.confirm { background: #c43c32; color: #fff; }
      .hold-action.cancel { background: #eceef1; color: #1c1f24; }
      .hold-action:disabled { opacity: .5; cursor: default; }
      .ripple {
        position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
        border-radius: 50%; border: 2px solid;
        animation: rip 360ms cubic-bezier(.16,1,.3,1) forwards;
      }
      .ripple.r2 {
        width: 6px; height: 6px; margin: -3px 0 0 -3px;
        border-width: 1.5px; animation-delay: 90ms;
      }
      @keyframes rip {
        from { transform: scale(.5); opacity: .95; }
        to { transform: scale(4.2); opacity: 0; }
      }
      /* 跨页胶囊：它在别的标签页干活时，当前页右上角留一个可点入口 */
      .xpage {
        position: absolute; right: 20px; top: 20px;
        display: none; align-items: center; gap: 9px;
        max-width: min(320px, calc(100vw - 40px));
        padding: 8px 12px; border-radius: 10px;
        background: rgba(23, 32, 51, .95); color: #fff;
        box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 8px 24px rgba(15,23,42,.35);
        font: 600 12.5px/1.4 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        pointer-events: auto; cursor: pointer;
      }
      .xpage.on { display: flex; }
      .xpage .xdot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
      .xpage .xtxt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .xpage .xmain { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .xpage .xsub {
        font-size: 10.5px; font-weight: 500; color: rgba(255,255,255,.62);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .highlight {
        position: absolute;
        box-sizing: border-box;
        pointer-events: none;
        border-radius: 6px;
        border: 2px solid var(--c);
        background: color-mix(in srgb, var(--c) 14%, transparent);
        mix-blend-mode: multiply;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.4), 0 0 14px color-mix(in srgb, var(--c) 35%, transparent);
        /* 三段：出现 ~125ms → 保持 → 消退 ~250ms。旧版 500ms 内连消失一起播完，看不清标了哪。 */
        animation: highlightTrace 1800ms cubic-bezier(.16,1,.3,1) forwards;
        will-change: opacity, transform;
      }
      .highlight.action-target {
        animation: none; background: transparent; mix-blend-mode: normal;
        border-width: 3px;
        box-shadow: 0 0 0 1.5px #fff, 0 0 0 3px #172033;
      }
      /* 操作完成：先留一小会儿让人看清点了哪，再消退 */
      .highlight.action-target.fading {
        animation: targetFade 400ms cubic-bezier(.16,1,.3,1) 500ms forwards;
      }
      @media (prefers-reduced-motion: reduce) {
        .cursor, .label, .svg-wrap { transition: none; }
        .cursor.pressing .svg-wrap { transform: none; }
        .ripple, .ripple.r2 { animation: rip-reduced 200ms ease-out forwards; }
        .highlight { animation: highlight-reduced 1600ms linear forwards; }
        @keyframes rip-reduced { from { opacity: .95; } to { opacity: 0; } }
        @keyframes highlight-reduced { 0% { opacity: 0; } 8% { opacity: 1; } 84% { opacity: 1; } 100% { opacity: 0; } }
      }
      @keyframes highlightTrace {
        0%   { opacity: 0; transform: scale(0.985); }
        7%   { opacity: 1; transform: scale(1); }
        86%  { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: scale(1.012); }
      }
      @keyframes targetFade {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    shadow.appendChild(style);

    highlightLayer = document.createElement("div");
    shadow.appendChild(highlightLayer);

    rippleLayer = document.createElement("div");
    shadow.appendChild(rippleLayer);
    (document.documentElement ?? document.body).appendChild(host);
    hookViewport();
  }

  function ensureMarksDom(): void {
    if (marksLayer) return;
    marksHost = document.createElement("div");
    marksHost.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_MARKS);
    marksHost.setAttribute("aria-hidden", "true");
    marksHost.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
    const marksShadow = marksHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .mark {
        position: absolute; box-sizing: border-box; pointer-events: none;
        border: 2.5px solid var(--c); border-radius: 8px;
        background: color-mix(in srgb, var(--c) 7%, transparent);
        box-shadow: 0 0 0 1px rgba(255,255,255,.5), 0 0 16px color-mix(in srgb, var(--c) 40%, transparent);
      }
      .mark-arrow {
        position: absolute; left: -30px; top: 50%; transform: translateY(-50%);
        display: block; overflow: visible;
        filter: drop-shadow(0 1px 2px rgba(15,23,42,.35));
      }
      .mark-arrow path, .mark-arrow line { stroke: var(--c); }
      .mark-label {
        position: absolute; left: -3px; top: -26px;
        padding: 1px 8px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 2px 6px rgba(15,23,42,.25);
      }
      .mark-label.below { top: calc(100% + 6px); }
      .mark.sketch {
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }
      .sketch-svg {
        position: absolute; left: 0; top: 0; width: 100%; height: 100%;
        overflow: visible; pointer-events: none;
      }
      .sketch-svg path {
        fill: none;
        stroke: var(--c);
        stroke-width: 2.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mark.sketch.grow path {
        stroke-dasharray: 1200;
        stroke-dashoffset: 1200;
        animation: markStrokeGrow 420ms cubic-bezier(.16, 1, .3, 1) forwards;
      }
      @keyframes markStrokeGrow {
        to { stroke-dashoffset: 0; }
      }
      @property --mark-boil-frame {
        syntax: "<integer>";
        inherits: true;
        initial-value: 0;
      }
      .mark.sketch.boil .sketch-svg {
        --mark-boil-frame: 0;
        animation: markBoilFrames 1200ms step-end infinite;
      }
      @keyframes markBoilFrames {
        0% { --mark-boil-frame: 0; }
        33.33% { --mark-boil-frame: 1; }
        66.67% { --mark-boil-frame: 2; }
      }
      .mark.sketch.boil .boil-path {
        --path-i: 0;
        opacity: clamp(0, 1 - (var(--mark-boil-frame) - var(--path-i)) * (var(--mark-boil-frame) - var(--path-i)), 1);
      }
      .mark.sketch.boil .boil-path[data-i="1"] { --path-i: 1; }
      .mark.sketch.boil .boil-path[data-i="2"] { --path-i: 2; }

      .mark-label.sketch-label {
        position: absolute;
        padding: 3px 10px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 11px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        box-shadow: 0 0 0 1.5px #fff, 0 3px 10px rgba(15,23,42,.28);
        white-space: nowrap;
      }
      @media (prefers-reduced-motion: reduce) {
        .mark.sketch.grow path { animation: none !important; stroke-dashoffset: 0 !important; }
        .mark.sketch.boil .sketch-svg { animation: none !important; }
        .mark.sketch.boil .boil-path { opacity: 1 !important; }
        .mark.sketch.boil .boil-path:not([data-i="0"]) { display: none !important; }
      }
    `;
    marksShadow.appendChild(style);
    marksLayer = document.createElement("div");
    marksShadow.appendChild(marksLayer);
    (document.documentElement ?? document.body).appendChild(marksHost);
    hookViewport();
  }

  function hookViewport(): void {
    if (viewportHooked) return;
    viewportHooked = true;
    window.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    // scroll 不冒泡；捕获才能听到内部 overflow 容器。滚动重锚 mark 与拿住态光标，不收光标。
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.visualViewport?.addEventListener("scroll", onScroll, { passive: true });
  }

  function onViewportResize(): void {
    for (const inst of instances.values()) {
      if (inst.action) {
        inst.labelSize = undefined;
        continue;
      }
      if (inst.highlightEl) {
        inst.highlightEl.remove();
        inst.highlightEl = undefined;
      }
      cancelFly(inst);
      if (inst.visible && !inst.hold) {
        const home = restPoint(inst.restIndex, window.innerWidth);
        setPos(inst, home);
        setResting(inst, true);
      }
    }
    relayoutMarks();
    relayoutHolds();
    relayoutActions();
  }

  function onScroll(): void {
    relayoutMarks();
    relayoutHolds();
    relayoutActions();
  }

  function liveAnchor(holder: { anchor: Element | null; target?: string }): Element | null {
    if (holder.anchor?.isConnected) return holder.anchor;
    if (holder.target) {
      const el = window.__sideagent?.dom?.resolve?.(holder.target) ?? null;
      if (el) holder.anchor = el;
      return el;
    }
    return null;
  }

  function relayoutMarks(): void {
    if (liveMarks.length === 0) return;
    for (const mark of liveMarks) {
      if (mark.observedNode) {
        const node = mark.observedNode;
        if (!node.isConnected) {mark.el.style.visibility = "hidden";continue;}
        let rect: DOMRect;
        if (node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();range.selectNodeContents(node);rect = range.getBoundingClientRect();
        } else rect = (node as Element).getBoundingClientRect();
        mark.el.style.visibility = rect.width && rect.height ? "" : "hidden";
        applyMarkBox(mark.el, rect, mark.pad, mark.label);
        continue;
      }
      const anchor = liveAnchor(mark);
      if (!anchor) {
        mark.el.style.visibility = "hidden";
        continue;
      }
      mark.el.style.visibility = "";
      const r = anchor.getBoundingClientRect();
      applyMarkBox(
        mark.el,
        { x: r.x, y: r.y, width: r.width, height: r.height },
        mark.pad,
        mark.label,
      );
    }
  }

  /** 拿住期间手跟目标走：若锚点有效则跟随目标最新位置；若锚点暂不可解（如 AX ref 或外部滚动），保持当前拿住点不误隐藏。 */
  function relayoutHolds(): void {
    for (const inst of instances.values()) {
      const hold = inst.hold;
      if (!hold) continue;
      const anchor = liveAnchor(hold);
      if (anchor) {
        const r = anchor.getBoundingClientRect();
        hold.point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      if (inst.visible) inst.el.classList.remove("hidden");
      cancelFly(inst);
      setPos(inst, hold.point);
    }
  }

  function getInstance(id: string): Instance {
    const existing = instances.get(id);
    if (existing) return existing;
    ensureDom();
    const el = document.createElement("div");
    el.className = "cursor hidden";
    el.innerHTML =
      `<div class="svg-wrap"><svg width="${CURSOR_SVG_SIZE}" height="${CURSOR_SVG_SIZE}" viewBox="0 0 24 24">` +
      `<path class="halo" d="${CURSOR_ARROW_PATH}" fill="none" stroke="#0f172a" stroke-width="${CURSOR_STROKE_HALO}" stroke-linejoin="round"/>` +
      `<path class="fill" d="${CURSOR_ARROW_PATH}" stroke="#ffffff" stroke-width="${CURSOR_STROKE_WHITE}" stroke-linejoin="round"/>` +
      `</svg></div>` +
      `<div class="label">${id === DEFAULT_ID ? DEFAULT_LABEL : displayNameFor(id)}</div>`;
    const color = cursorColor(id);
    el.style.setProperty("--c", color);
    shadow!.appendChild(el);
    const restIndex = instances.size;
    const home = restPoint(restIndex, window.innerWidth);
    const inst: Instance = {
      el,
      color,
      visible: false,
      restIndex,
      pos: home,
      resting: true,
      name: id === DEFAULT_ID ? DEFAULT_LABEL : displayNameFor(id),
    };
    instances.set(id, inst);
    return inst;
  }

  function setPos(inst: Instance, p: { x: number; y: number }): void {
    inst.pos = p;
    inst.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (inst.action) positionActionLabel(inst);
    else if (inst.status && !inst.hold) inst.el.classList.toggle("flip", p.x > window.innerWidth * 0.6);
  }

  function positionActionLabel(inst: Instance): void {
    if (!inst.action) return;
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    const size = inst.labelSize ??= { width: label.offsetWidth, height: label.offsetHeight };
    const p = cursorLabelPosition(inst.pos, size, { width: window.innerWidth, height: window.innerHeight }, inst.action.rect);
    label.style.left = `${p.x - inst.pos.x}px`;
    label.style.top = `${p.y - inst.pos.y}px`;
  }

  function clearAction(inst: Instance): void {
    inst.action = undefined;
    inst.labelSize = undefined;
    inst.el.classList.remove("acting");
    inst.highlightEl?.remove();
    inst.highlightEl = undefined;
    refreshLabel(inst);
  }

  /** 名牌正文渲染：动作与状态共用同一块牌子。 */
  function paintLabel(inst: Instance, main: string, sub: string): void {
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    const line = document.createElement("span");
    line.className = "action-text";
    line.textContent = main;
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = sub;
    label.replaceChildren(line, name);
    inst.labelSize = undefined;
    positionActionLabel(inst);
  }

  /** 优先级：拿住双键 > 动作 > 状态 > 成员名。 */
  function refreshLabel(inst: Instance): void {
    if (inst.hold) return;
    if (inst.action) {
      inst.el.classList.remove("stating");
      renderActionLabel(inst);
      return;
    }
    if (inst.status) {
      renderStatusLabel(inst);
      return;
    }
    inst.el.classList.remove("stating");
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    label.removeAttribute("style");
    label.textContent = inst.name;
    inst.labelSize = undefined;
  }

  function renderActionLabel(inst: Instance): void {
    const action = inst.action!;
    const verb = { click: "点击", fill: "填写", hover: "定位" }[action.kind];
    const text = action.phase === "active" ? `正在${verb}`
      : action.phase === "failed" ? "操作未完成"
      : action.phase === "unknown" ? "结果待确认"
      : action.kind === "click" ? "已点击" : `${verb}结束`;
    paintLabel(inst, text + (action.name ? ` · ${action.name}` : ""), inst.name);
  }

  function relayoutActions(): void {
    for (const inst of instances.values()) {
      const action = inst.action;
      if (!action) continue;
      if (action.anchor) {
        if (!action.anchor.isConnected) {
          clearAction(inst);
          schedulePark(inst);
          continue;
        }
        const r = action.anchor.getBoundingClientRect();
        action.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      const r = action.rect;
      if (r && inst.highlightEl) {
        const b = highlightBounds(r);
        const visible = b && r.x + r.width > 0 && r.y + r.height > 0 && r.x < innerWidth && r.y < innerHeight;
        inst.highlightEl.style.visibility = visible ? "" : "hidden";
        if (b) Object.assign(inst.highlightEl.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
        // 飞行结束后随实际元素移动，不重新解析同名节点。
        if (visible && inst.action?.arrived && inst.raf === undefined) setPos(inst, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
      }
      positionActionLabel(inst);
    }
  }

  function followActions(): void {
    if (actionFrame !== undefined) return;
    const tick = () => {
      actionFrame = undefined;
      relayoutActions();
      if ([...instances.values()].some(inst => inst.action)) actionFrame = requestAnimationFrame(tick);
    };
    actionFrame = requestAnimationFrame(tick);
  }

  function actionName(anchor?: Element, fallback?: string): string {
    // 不读取字段值或 contenteditable 正文；只使用控件名称。
    const root = anchor?.getRootNode() as Document | ShadowRoot | undefined;
    const labelledBy = anchor?.getAttribute("aria-labelledby")?.split(/\s+/).map(id => root?.getElementById?.(id)?.textContent ?? "").join(" ");
    const labels = anchor && "labels" in anchor ? Array.from((anchor as HTMLInputElement).labels ?? []).map(el => el.textContent).join(" ") : "";
    const editable = anchor?.matches("input, textarea, [contenteditable]");
    const text = anchor?.getAttribute("aria-label") || labelledBy || labels || anchor?.getAttribute("title") ||
      anchor?.getAttribute("placeholder") || (!editable ? anchor?.textContent : "") || fallback || "";
    return text.trim().replace(/\s+/g, " ").slice(0, 40);
  }

  function setResting(inst: Instance, on: boolean): void {
    inst.resting = on;
    inst.el.classList.toggle("rest", on);
    inst.el.classList.toggle("flip", on && restOnRight(inst.restIndex));
  }

  // ── 状态层：在等 / 在读 / 完成 / 失败 ────────────────────────────────

  function statusSub(inst: Instance): string {
    const status = inst.status!;
    if (status.clock) return `已等 ${Math.max(0, Math.floor((Date.now() - status.since) / 1000))} 秒`;
    return status.detail || status.sub || inst.name;
  }

  function renderStatusLabel(inst: Instance): void {
    const status = inst.status!;
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    label.removeAttribute("style");
    inst.labelSize = undefined;
    inst.el.classList.add("stating");
    inst.el.style.setProperty("--s", STATUS_COPY[status.state].color);
    inst.el.classList.toggle("flip", inst.pos.x > window.innerWidth * 0.6);
    paintLabel(inst, status.text, statusSub(inst));
  }

  function clearStatusTimers(inst: Instance): void {
    if (inst.status?.tick !== undefined) clearInterval(inst.status.tick);
    if (inst.status?.clearTimer !== undefined) clearTimeout(inst.status.clearTimer);
  }

  function startStatusTimers(inst: Instance): void {
    const status = inst.status!;
    const copy = STATUS_COPY[status.state];
    if (copy.clock) {
      const since = status.since;
      status.tick = setInterval(() => {
        // 动作名牌或拿住双键接管时不动别人的第二行
        if (inst.status !== status || !inst.el.classList.contains("stating")) return;
        const line = inst.el.querySelector<HTMLDivElement>(".agent-name");
        if (line) line.textContent = `已等 ${Math.max(0, Math.floor((Date.now() - since) / 1000))} 秒`;
      }, 1000);
    }
    const hideAfter = status.autoHideMs ?? copy.autoHideMs;
    if (hideAfter !== undefined) {
      status.clearTimer = setTimeout(() => {
        clearStatusInst(inst);
        parkNow(inst);
      }, hideAfter);
    }
  }

  function setStatusInst(inst: Instance, view: CursorStatusView): void {
    const copy = STATUS_COPY[view.state];
    if (!copy) return;
    clearStatusTimers(inst);
    inst.status = {
      state: view.state,
      text: view.text || copy.text,
      detail: view.detail || "",
      sub: copy.sub || "",
      clock: Boolean(copy.clock),
      since: Date.now(),
      autoHideMs: view.autoHideMs,
    };
    if (!inst.visible) showAtRest(inst);
    // 失败停在原地等处理：取消自动回角落，别把出错位置挪走
    if (view.state === "failed") {
      clearTimeout(inst.parkTimer);
      setResting(inst, false);
    }
    startStatusTimers(inst);
    // 拿住态（就地确认双键）优先，状态等松开后再画
    if (!inst.hold) renderStatusLabel(inst);
  }

  function clearStatusInst(inst: Instance): void {
    if (!inst.status) return;
    clearStatusTimers(inst);
    inst.status = undefined;
    refreshLabel(inst);
  }

  function cancelFly(inst: Instance): void {
    if (inst.raf !== undefined) {
      cancelAnimationFrame(inst.raf);
      inst.raf = undefined;
    }
  }

  function showAtRest(inst: Instance): void {
    const home = restPoint(inst.restIndex, window.innerWidth);
    setPos(inst, home);
    setResting(inst, true);
    inst.el.classList.remove("hidden");
    inst.visible = true;
  }

  function flyTo(inst: Instance, to: { x: number; y: number }): number {
    cancelFly(inst);
    const from = inst.pos;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2 || reducedMotion.matches) {
      setPos(inst, to);
      if (inst.action) inst.action.arrived = true;
      return 0;
    }
    const ms = flightMs(from, to);
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setPos(inst, pointOnArc(from, to, easeInOutCubic(t)));
      if (t < 1) inst.raf = requestAnimationFrame(tick);
      else {
        inst.raf = undefined;
        if (inst.action) inst.action.arrived = true;
        setPos(inst, to);
      }
    };
    inst.raf = requestAnimationFrame(tick);
    return ms;
  }

  function schedulePark(inst: Instance): void {
    clearTimeout(inst.parkTimer);
    inst.parkTimer = setTimeout(() => parkNow(inst), PARK_AFTER_MS);
  }

  /** 立刻回待命角落（状态收完就是这么走的，不再多等一次 park 延迟）。 */
  function parkNow(inst: Instance): void {
    if (inst.action?.phase === "active") return;
    if (inst.action) clearAction(inst);
    const home = restPoint(inst.restIndex, window.innerWidth);
    setResting(inst, true);
    flyTo(inst, home);
  }

  function spawnRipple(x: number, y: number, cls: string, color: string): void {
    const ripple = document.createElement("div");
    ripple.className = cls;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.borderColor = color;
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    rippleLayer!.appendChild(ripple);
  }

  function spawnHighlight(inst: Instance, rect: SideAgentRect): void {
    const bounds = highlightBounds(rect, HIGHLIGHT_PAD);
    if (!bounds) return;
    ensureDom();
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
    const el = document.createElement("div");
    el.className = "highlight";
    el.style.setProperty("--c", inst.color);
    el.style.left = `${bounds.left}px`;
    el.style.top = `${bounds.top}px`;
    el.style.width = `${bounds.width}px`;
    el.style.height = `${bounds.height}px`;

    const remove = () => {
      el.remove();
      if (inst.highlightEl === el) {
        inst.highlightEl = undefined;
      }
    };
    el.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, 1900);
    inst.highlightEl = el;
    highlightLayer!.appendChild(el);
  }

  function resolveAnchor(rect: SideAgentRect, target?: string): Element | null {
    if (target) {
      const el = window.__sideagent?.dom?.resolve?.(target);
      if (el) return el;
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return document.elementFromPoint(cx, cy);
  }

  function applyMarkBox(
    el: HTMLDivElement,
    rect: SideAgentRect,
    pad: number,
    label?: string,
  ): void {
    const box = viewportRectToDocumentBox(rect, window.scrollX, window.scrollY, pad);
    if (!box) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    const labelEl = el.querySelector(".mark-label");
    if (labelEl && label) {
      labelEl.classList.toggle("below", markLabelPlacement(rect.y) === "below");
    }
  }

  /** 拿住态名牌：成员色 pill 内嵌确认红 / 取消灰双键；点下去发 mark_action（与侧栏打字同一条路）。 */
  function armHoldLabel(inst: Instance, actions: MarkAction[]): void {
    const labelEl = inst.el.querySelector<HTMLDivElement>(".label");
    if (!labelEl) return;
    inst.el.classList.remove("stating"); // 拿住态压过状态层，别把状态底色带到双键上
    labelEl.replaceChildren();
    inst.el.dataset.armed = "1";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `hold-action ${action.id}`;
      btn.dataset.action = action.id;
      btn.textContent = action.label;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (inst.el.dataset.armed === "0") return;
        inst.el.dataset.armed = "0";
        for (const b of labelEl.querySelectorAll("button")) b.disabled = true;
        try {
          chrome.runtime.sendMessage({ type: "mark_action", action: action.id }, () => {
            void chrome.runtime.lastError;
          });
        } catch {
          /* 无扩展运行时（自检页）忽略 */
        }
      });
      labelEl.appendChild(btn);
    }
  }

  /** 松开：摘掉按住姿态、名牌恢复成员名、清锚点。不动可见性。 */
  function releaseHoldInst(inst: Instance): void {
    const hold = inst.hold;
    if (!hold) return;
    inst.hold = undefined;
    clearTimeout(inst.pressTimer);
    inst.el.classList.remove("pressing", "holding");
    delete inst.el.dataset.armed;
    // 确认锚框跟着拿住态一起走：用户确认/取消或动作换手后，"待确认"不该留在页面上
    if (hold.mark) removeMark(hold.mark);
    refreshLabel(inst);
  }

  /** 拿住：飞到目标点进入持久按住态（不弹回、不 park、rest/flip 不藏名牌），名牌变双键。 */
  function holdInst(
    inst: Instance,
    x: number,
    y: number,
    actions: MarkAction[],
    target?: string,
    anchorMark?: HTMLDivElement | null,
  ): void {
    releaseHoldInst(inst);
    if (inst.action) clearAction(inst);
    clearTimeout(inst.parkTimer);
    clearTimeout(inst.pressTimer);
    if (!inst.visible) showAtRest(inst);
    setResting(inst, false);
    inst.el.classList.remove("hidden");
    inst.visible = true;
    const name = inst.el.querySelector(".label")?.textContent ?? "";
    inst.hold = {
      point: { x, y },
      target,
      anchor: resolveAnchor({ x: x - 1, y: y - 1, width: 2, height: 2 }, target),
      name,
      mark: anchorMark ?? undefined,
    };
    armHoldLabel(inst, actions);
    inst.el.classList.add("pressing", "holding");
    flyTo(inst, { x, y });
  }

  function spawnMark(
    inst: Instance,
    rect: SideAgentRect,
    label?: string,
    target?: string,
    actions?: MarkAction[],
    options?: MarkOptions,
    observedNode?: Node,
  ): HTMLDivElement | null {
    const opts = { ...defaultMarkOptions, ...options };
    const isSketch = opts.style === "sketch";
    const motion = opts.motion ?? "grow";
    const pad = isSketch ? 10 : MARK_PAD;
    const box = viewportRectToDocumentBox(rect, window.scrollX, window.scrollY, pad);
    if (!box) return null;
    ensureMarksDom();
    const el = document.createElement("div");
    el.className = isSketch ? `mark sketch ${motion === "boil" ? "boil" : "grow"}` : "mark";
    el.style.setProperty("--c", inst.color);

    const seed = opts.seed ?? (Math.floor(Math.random() * 1000000) + 1);

    if (isSketch) {
      const cx = box.width / 2;
      const cy = box.height / 2;
      const rx = box.width / 2 + 8;
      const ry = box.height / 2 + 6;

      const arrowX1 = cx - rx - 36;
      const arrowY1 = cy - ry - 14;
      const arrowX2 = cx - rx + 3;
      const arrowY2 = cy - 4;

      if (motion === "boil") {
        const frames = [0, 1, 2].map((i) => {
          const o = { seed, roughness: 1.1, boil: 0.45, boilSeed: seed + (i + 1) * 7919 };
          const e = roughEllipse(cx, cy, rx, ry, o);
          const a = roughArrow(arrowX1, arrowY1, arrowX2, arrowY2, { ...o, seed: seed + 7 });
          return `${e} ${a}`;
        });
        el.innerHTML =
          `<svg class="sketch-svg" style="left:0;top:0;width:100%;height:100%;">` +
          frames.map((f, i) => `<path class="boil-path frame-${i}" data-i="${i}" d="${f}"/>`).join("") +
          `</svg>` +
          (label ? `<div class="mark-label sketch-label"></div>` : "");
      } else {
        const ellipsePath = roughEllipse(cx, cy, rx, ry, { seed, roughness: 1.1 });
        const arrowPath = roughArrow(arrowX1, arrowY1, arrowX2, arrowY2, { seed: seed + 7, roughness: 1.0 });
        el.innerHTML =
          `<svg class="sketch-svg anim-stroke-grow" style="left:0;top:0;width:100%;height:100%;">` +
          `<path class="rough-ellipse-path" d="${ellipsePath}"/>` +
          `<path class="sketch-arrow-path" d="${arrowPath}"/>` +
          `</svg>` +
          (label ? `<div class="mark-label sketch-label"></div>` : "");
      }
    } else {
      el.innerHTML =
        `<svg class="mark-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none">` +
        `<path d="M2 12h17m-6-6 6 6-6 6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</svg>` +
        (label ? `<div class="mark-label"></div>` : "");
    }

    if (label) {
      const labelEl = el.querySelector<HTMLElement>(".mark-label")!;
      labelEl.textContent = label;
      if (isSketch) {
        const cx = box.width / 2;
        const cy = box.height / 2;
        const rx = box.width / 2 + 8;
        const ry = box.height / 2 + 6;
        const arrowX1 = cx - rx - 36;
        const arrowY1 = cy - ry - 14;
        labelEl.style.left = `${arrowX1 - 70}px`;
        labelEl.style.top = `${arrowY1 - 16}px`;
      }
    }
    applyMarkBox(el, rect, pad, label);
    marksLayer!.appendChild(el);
    liveMarks.push({
      el,
      anchor: observedNode ? null : resolveAnchor(rect, target),
      observedNode,
      target,
      pad,
      label,
      options: opts,
      seed,
    });
    return el;
  }

  /** 只撤指定的一条标注（拿住态的确认锚框），不碰模型画的其他标注。 */
  function removeMark(el: HTMLDivElement): void {
    const at = liveMarks.findIndex((mark) => mark.el === el);
    if (at >= 0) liveMarks.splice(at, 1);
    el.remove();
  }

  function stopReplayInst(inst: Instance): void {
    inst.replayGen = (inst.replayGen ?? 0) + 1;
    cancelFly(inst);
    clearTimeout(inst.replayTimer);
  }

  function waitReplay(inst: Instance, gen: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      clearTimeout(inst.replayTimer);
      inst.replayTimer = setTimeout(resolve, Math.max(0, ms));
    });
  }

  async function runReplay(
    inst: Instance,
    points: Array<{ x: number; y: number; click: boolean }>,
  ): Promise<void> {
    const gen = (inst.replayGen ?? 0) + 1;
    inst.replayGen = gen;
    cancelFly(inst);
    clearTimeout(inst.parkTimer);
    if (!inst.visible) showAtRest(inst);
    setResting(inst, false);
    inst.el.classList.remove("hidden");
    inst.visible = true;
    for (const p of points) {
      if (inst.replayGen !== gen) return;
      if (
        p.x - window.scrollX < 8 ||
        p.y - window.scrollY < 8 ||
        p.x - window.scrollX > window.innerWidth - 8 ||
        p.y - window.scrollY > window.innerHeight - 8
      ) {
        window.scrollTo(Math.max(0, p.x - window.innerWidth / 2), Math.max(0, p.y - window.innerHeight / 2));
      }
      const to = { x: p.x - window.scrollX, y: p.y - window.scrollY };
      const ms = flyTo(inst, to);
      await waitReplay(inst, gen, ms);
      if (inst.replayGen !== gen) return;
      if (p.click) {
        spawnRipple(to.x, to.y, "ripple", inst.color);
        spawnRipple(to.x, to.y, "ripple r2", inst.color);
        inst.el.classList.add("pressing");
        clearTimeout(inst.pressTimer);
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        await waitReplay(inst, gen, 180);
      }
    }
    if (inst.replayGen === gen) schedulePark(inst);
  }

  function ensureControlDom(): HTMLDivElement {
    if (controlBar) return controlBar;
    controlHost = document.createElement("div");
    controlHost.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_CONTROL);
    controlHost.style.cssText =
      "position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
    const controlShadow = controlHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .bar {
        position: absolute; left: 12px; top: 12px;
        display: inline-flex; align-items: center; gap: 10px;
        width: max-content; max-width: calc(100vw - 24px);
        pointer-events: auto;
        background: #fff; color: #1c1f24;
        border-radius: 10px; padding: 8px 10px;
        box-shadow: 0 8px 24px rgba(15,23,42,.12), 0 0 0 .5px rgba(15,23,42,.12);
        font: 600 13px/1.3 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        opacity: 0; transform: translateY(-6px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      .bar.on { opacity: 1; transform: none; }
      .bar b { font-weight: 600; white-space: nowrap; }
      .bar .sub { color: #7c828b; font: 500 11px/1.2 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; white-space: nowrap; }
      .bar .stack { display: flex; margin-left: 1px; }
      .bar .avatar {
        width: 16px; height: 16px; margin-left: -4px;
        border: 2px solid #fff; border-radius: 50%;
        display: grid; place-items: center; color: #fff;
        font: 700 8px/1 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        background: #56667d;
      }
      .bar .avatar:first-child { margin-left: 0; }
      .bar button {
        font: 600 12px/1 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        border: 0; border-radius: 8px; padding: 7px 10px;
        background: #1c1f24; color: #fff; cursor: pointer;
      }
      .bar button:disabled { opacity: .55; cursor: default; }
    `;
    controlBar = document.createElement("div");
    controlBar.className = "bar";
    const status = document.createElement("b");
    status.textContent = "现在归你";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "交还";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      try {
        chrome.runtime.sendMessage({ type: "handback_click" }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        /* 无扩展运行时（自检页）忽略 */
      }
    });
    controlBar.append(status, btn);
    controlShadow.append(style, controlBar);
    (document.documentElement ?? document.body).appendChild(controlHost);
    return controlBar;
  }

  function applyControlView(view?: {
    status?: string;
    sub?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    const bar = ensureControlDom();
    const status = bar.querySelector("b");
    const btn = bar.querySelector("button");
    let sub = bar.querySelector<HTMLElement>(".sub");
    let stack = bar.querySelector<HTMLElement>(".stack");
    if (status) status.textContent = view?.status || "现在归你";
    const subText = view?.sub?.trim() ?? "";
    if (subText) {
      if (!sub) {
        sub = document.createElement("span");
        sub.className = "sub";
        status?.after(sub);
      }
      sub.textContent = subText;
    } else {
      sub?.remove();
    }
    const members = view?.members ?? [];
    if (members.length > 0) {
      if (!stack) {
        stack = document.createElement("div");
        stack.className = "stack";
        (bar.querySelector(".sub") ?? status)?.after(stack);
      }
      stack.replaceChildren();
      for (const m of members) {
        const av = document.createElement("i");
        av.className = "avatar";
        av.textContent = m.initial || "?";
        if (m.color) av.style.background = m.color;
        stack.appendChild(av);
      }
    } else {
      stack?.remove();
    }
    if (btn) {
      const action = view?.action ?? "交还";
      btn.textContent = action;
      btn.hidden = !action;
      btn.disabled = view?.actionEnabled === false;
    }
  }

  function showUserControl(view?: {
    status?: string;
    sub?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    applyControlView(view);
    const bar = ensureControlDom();
    bar.classList.add("on");
  }

  function hideUserControl(): void {
    if (!controlBar) return;
    controlBar.classList.remove("on");
  }

  function hide(inst: Instance): void {
    stopReplayInst(inst);
    cancelFly(inst);
    clearTimeout(inst.parkTimer);
    releaseHoldInst(inst);
    clearStatusInst(inst);
    if (inst.action) clearAction(inst);
    inst.el.classList.add("hidden");
    inst.el.classList.remove("pressing", "rest", "flip");
    inst.visible = false;
    inst.resting = true;
    if (inst.highlightEl) {
      inst.highlightEl.remove();
      inst.highlightEl = undefined;
    }
  }

  // ── 跨页胶囊：它在别的标签页干活时，当前页右上角的可点入口 ──────────────

  let crossPill: HTMLDivElement | null = null;
  let crossPillSession = "";

  function ensureCrossPill(): HTMLDivElement {
    ensureDom();
    if (crossPill?.isConnected) return crossPill;
    crossPill = document.createElement("div");
    crossPill.className = "xpage";
    crossPill.innerHTML =
      `<span class="xdot"></span>` +
      `<span class="xtxt"><span class="xmain"></span><span class="xsub"></span></span>`;
    crossPill.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "cross_page_click", sessionId: crossPillSession }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        /* 无扩展运行时（自检页）忽略 */
      }
    });
    shadow!.appendChild(crossPill);
    return crossPill;
  }

  function showCrossPill(view: { sessionId?: string; title?: string; state?: CursorStatusState }): void {
    const el = ensureCrossPill();
    crossPillSession = view.sessionId ?? "";
    const copy = STATUS_COPY[view.state ?? "waiting"];
    el.querySelector<HTMLSpanElement>(".xdot")!.style.background = copy?.color ?? "#2f6fed";
    el.querySelector<HTMLSpanElement>(".xmain")!.textContent = "正在另一个标签页工作";
    el.querySelector<HTMLSpanElement>(".xsub")!.textContent = `${view.title?.trim() || "另一个页面"} ↗`;
    el.classList.add("on");
  }

  function hideCrossPill(): void {
    crossPill?.classList.remove("on");
  }

  function teardown(): void {
    if (actionFrame !== undefined) cancelAnimationFrame(actionFrame);
    actionFrame = undefined;
    for (const inst of instances.values()) {
      stopReplayInst(inst);
      cancelFly(inst);
      clearTimeout(inst.parkTimer);
      clearTimeout(inst.pressTimer);
      clearStatusTimers(inst);
    }
    instances.clear();
    liveMarks.length = 0;
    host?.remove();
    marksHost?.remove();
    controlHost?.remove();
    crossPill = null;
    crossPillSession = "";
    host = null;
    marksHost = null;
    controlHost = null;
    controlBar = null;
    shadow = null;
    highlightLayer = null;
    rippleLayer = null;
    marksLayer = null;
    ns.cursor = undefined;
    ns.cursorHidden = undefined;
    ns.cursorState = undefined;
    ns.markLayout = undefined;
    ns.markLayerCount = undefined;
    ns.holdState = undefined;
    ns.holdActionLabels = undefined;
    ns.clickHoldAction = undefined;
    ns.controlBanner = undefined;
    ns.clickHandback = undefined;
    ns.cursorStatus = undefined;
    ns.crossPageState = undefined;
    ns.clickCrossPage = undefined;
    ns.setMarkConfig = undefined;
    ns.getMarkConfig = undefined;
    ns.markDetails = undefined;
  }

  window.addEventListener("pagehide", teardown);

  function api(id: string): SideAgentCursor {
    return {
      beginAction(actionId, kind, rect, anchor, label): void {
        const inst = getInstance(id);
        releaseHoldInst(inst);
        clearTimeout(inst.parkTimer);
        stopReplayInst(inst);
        if (inst.action) clearAction(inst);
        if (!inst.visible) showAtRest(inst);
        inst.action = { id: actionId, kind, phase: "active", anchor, rect, name: actionName(anchor, label) };
        setResting(inst, false);
        inst.el.classList.add("acting");
        if (rect && anchor) {
          inst.highlightEl?.remove();
          inst.highlightEl = document.createElement("div");
          inst.highlightEl.className = "highlight action-target";
          inst.highlightEl.style.setProperty("--c", inst.color);
          highlightLayer!.appendChild(inst.highlightEl);
        }
        renderActionLabel(inst);
        followActions();
      },

      endAction(actionId, outcome, point): void {
        const inst = instances.get(id);
        if (!inst?.action || inst.action.id !== actionId || inst.action.phase !== "active") return;
        cancelFly(inst);
        inst.action.phase = outcome;
        if (outcome === "done" && inst.action.kind === "click" && point) {
          setPos(inst, { x: point[0], y: point[1] });
          api(id).click(point[0], point[1]);
        }
        if (outcome !== "done") {
          inst.highlightEl?.remove();
          inst.highlightEl = undefined;
        } else if (inst.highlightEl) {
          // 操作完成：标记先留一下让人看清点了哪，再消退（06 trace），不是原地长留
          const el = inst.highlightEl;
          inst.highlightEl = undefined;
          el.classList.add("fading");
          el.addEventListener("animationend", () => el.remove(), { once: true });
          window.setTimeout(() => el.remove(), 1200);
        }
        renderActionLabel(inst);
        schedulePark(inst);
      },
      arrive(x, y): void {
        const inst = instances.get(id);
        if (!inst?.visible) return;
        cancelFly(inst);
        if (inst.action) inst.action.arrived = true;
        setPos(inst, { x, y });
      },
      move(x: number, y: number): number {
        const inst = getInstance(id);
        releaseHoldInst(inst);
        clearTimeout(inst.parkTimer);
        if (!inst.visible) showAtRest(inst);
        setResting(inst, false);
        inst.el.classList.remove("hidden");
        inst.visible = true;
        return flyTo(inst, { x, y });
      },

      click(x: number, y: number): void {
        const inst = getInstance(id);
        releaseHoldInst(inst);
        clearTimeout(inst.pressTimer);
        inst.el.classList.add("pressing");
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        spawnRipple(x, y, "ripple", inst.color);
        spawnRipple(x, y, "ripple r2", inst.color);
        schedulePark(inst);
      },

      hold(x: number, y: number, actions: MarkAction[], target?: string): void {
        const parsed = parseMarkActions(actions);
        if (!parsed) return;
        holdInst(getInstance(id), x, y, parsed, target);
      },

      releaseHold(): void {
        const inst = instances.get(id);
        if (!inst) return;
        releaseHoldInst(inst);
        if (inst.visible) schedulePark(inst);
      },

      park(): void {
        const inst = getInstance(id);
        if (!inst.visible) {
          showAtRest(inst);
          return;
        }
        schedulePark(inst);
      },

      replay(points: Array<{ x: number; y: number; click: boolean }>): void {
        void runReplay(getInstance(id), points);
      },

      stopReplay(): void {
        const inst = instances.get(id);
        if (inst) stopReplayInst(inst);
      },

      hide(): void {
        const inst = instances.get(id);
        if (inst) hide(inst);
      },

      setStatus(view?: CursorStatusView): void {
        if (!view?.state) return;
        setStatusInst(getInstance(id), view);
      },

      clearStatus(): void {
        const inst = instances.get(id);
        if (inst) clearStatusInst(inst);
      },

      showCrossPage(view?: { sessionId?: string; title?: string; state?: CursorStatusState }): void {
        showCrossPill(view ?? {});
      },

      hideCrossPage(): void {
        hideCrossPill();
      },

      showUserControl(view?: {
        status?: string;
        sub?: string;
        action?: string;
        actionEnabled?: boolean;
        members?: Array<{ id: string; initial: string; color: string }>;
      }): void {
        showUserControl(view);
      },

      hideUserControl(): void {
        hideUserControl();
      },

      highlight(rect: SideAgentRect): void {
        const inst = getInstance(id);
        spawnHighlight(inst, rect);
      },

      mark(
        rect: SideAgentRect,
        label?: string,
        target?: string,
        actions?: MarkAction[],
        options?: MarkOptions,
        observedNode?: Node,
      ): void {
        const inst = getInstance(id);
        const mark = spawnMark(inst, rect, label, target, actions, options, observedNode);
        // 就地确认与 held 拦阻同一形态：键不在框外，光标飞到目标拿住，双键长在名牌上
        const parsed = resolveImplicitMarkActions(label, actions);
        if (parsed) {
          holdInst(inst, Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), parsed, target, mark);
        }
      },

      clearMarks(): void {
        liveMarks.length = 0;
        marksLayer?.replaceChildren();
      },

      for(instanceId: string): SideAgentCursor {
        return api(instanceId);
      },
    };
  }

  ns.cursor = api(DEFAULT_ID);
  ns.cursorState = (id = DEFAULT_ID) => {
    const inst = instances.get(id);
    if (!inst) return null;
    const r = inst.el.querySelector(".label")?.getBoundingClientRect();
    return { action: inst.action?.id ?? null, phase: inst.action?.phase ?? null,
      label: inst.el.querySelector(".label")?.textContent ?? "", labelRect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      targetRect: inst.action?.rect ?? null, hidden: !inst.visible, resting: inst.resting, x: inst.pos.x, y: inst.pos.y, size: CURSOR_SVG_SIZE };
  };
  ns.cursorHidden = () => {
    const inst = instances.get(DEFAULT_ID);
    return !inst || !inst.visible;
  };
  ns.cursorStatus = (id = DEFAULT_ID) => {
    const inst = instances.get(id);
    if (!inst) return null;
    const label = inst.el.querySelector<HTMLDivElement>(".label");
    const rect = label?.getBoundingClientRect();
    const computed = label ? getComputedStyle(label) : null;
    const nameEl = inst.el.querySelector<HTMLDivElement>(".agent-name");
    return {
      state: inst.status?.state ?? null,
      text: inst.el.querySelector<HTMLDivElement>(".action-text")?.textContent ?? "",
      detail: nameEl?.textContent ?? "",
      fontSize: computed?.fontSize ?? "",
      nameFontSize: nameEl ? getComputedStyle(nameEl).fontSize : "",
      borderColor: computed?.borderLeftColor ?? "",
      opacity: computed ? Number(computed.opacity) : 0,
      labelRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      x: inst.pos.x,
      y: inst.pos.y,
      hidden: !inst.visible,
      resting: inst.resting,
    };
  };
  ns.crossPageState = () => {
    if (!crossPill?.classList.contains("on")) return null;
    const rect = crossPill.getBoundingClientRect();
    return {
      main: crossPill.querySelector<HTMLSpanElement>(".xmain")?.textContent ?? "",
      sub: crossPill.querySelector<HTMLSpanElement>(".xsub")?.textContent ?? "",
      sessionId: crossPillSession,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  };
  ns.clickCrossPage = () => {
    if (!crossPill?.classList.contains("on")) return false;
    crossPill.click();
    return true;
  };
  ns.controlBanner = () => {
    if (!controlBar || !controlBar.classList.contains("on")) return null;
    const statusEl = controlBar.querySelector("b");
    const actionEl = controlBar.querySelector("button");
    const barRect = controlBar.getBoundingClientRect();
    const statusRect = statusEl?.getBoundingClientRect();
    const actionRect = actionEl?.getBoundingClientRect();
    return {
      status: statusEl?.textContent ?? "",
      action: actionEl?.textContent ?? "",
      barWidth: barRect.width,
      statusRight: statusRect?.right ?? 0,
      actionLeft: actionRect?.left ?? 0,
      actionRight: actionRect?.right ?? 0,
      viewportWidth: window.innerWidth,
    };
  };
  ns.clickHandback = () => {
    const btn = controlBar?.querySelector("button");
    if (!btn || !controlBar?.classList.contains("on")) return false;
    btn.click();
    return true;
  };
  ns.holdActionLabels = () =>
    [...instances.values()]
      .filter((inst) => inst.hold)
      .flatMap((inst) =>
        [...inst.el.querySelectorAll<HTMLButtonElement>(".hold-action")].map((b) => ({
          id: b.dataset.action ?? "",
          label: b.textContent ?? "",
        })),
      );
  ns.clickHoldAction = (actionId: string) => {
    if (!isMarkActionId(actionId)) return false;
    const btn = [...instances.values()]
      .filter((inst) => inst.hold)
      .flatMap((inst) => [...inst.el.querySelectorAll<HTMLButtonElement>(".hold-action")])
      .find((b) => b.dataset.action === actionId);
    if (!btn) return false;
    btn.click();
    return true;
  };
  ns.holdState = (instanceId?: string) => {
    const inst = instances.get(instanceId ?? DEFAULT_ID);
    if (!inst) return null;
    return {
      holding: Boolean(inst.hold),
      pressing: inst.el.classList.contains("pressing"),
      hidden: inst.el.classList.contains("hidden") || !inst.visible,
      x: inst.pos.x,
      y: inst.pos.y,
    };
  };
  ns.markLayout = () =>
    liveMarks.map((m) => ({
      x: parseFloat(m.el.style.left) || 0,
      y: parseFloat(m.el.style.top) || 0,
      width: parseFloat(m.el.style.width) || 0,
      height: parseFloat(m.el.style.height) || 0,
    }));
  /** overlay 自检：标注层真实子节点数（不等于 liveMarks 记账） */
  ns.markLayerCount = () => marksLayer?.childElementCount ?? 0;
  ns.setMarkConfig = (opts: MarkOptions) => {
    defaultMarkOptions = { ...defaultMarkOptions, ...opts };
  };
  ns.getMarkConfig = () => ({ ...defaultMarkOptions });
  ns.markDetails = () =>
    liveMarks.map((m) => {
      const svg = m.el.querySelector("svg.sketch-svg");
      const boilPaths = svg ? [...svg.querySelectorAll(".boil-path")] : [];
      const ellipsePath = svg?.querySelector(".rough-ellipse-path");
      const arrowPath = svg?.querySelector(".sketch-arrow-path");
      const labelEl = m.el.querySelector(".sketch-label") ?? m.el.querySelector(".mark-label");
      return {
        className: m.el.className,
        hasSvg: Boolean(svg),
        isGrow: m.el.classList.contains("grow"),
        isBoil: m.el.classList.contains("boil"),
        isSketch: m.el.classList.contains("sketch"),
        hasEllipse: Boolean(ellipsePath),
        hasArrow: Boolean(arrowPath),
        boilFrameCount: boilPaths.length,
        labelText: labelEl?.textContent ?? "",
      };
    });
})();
