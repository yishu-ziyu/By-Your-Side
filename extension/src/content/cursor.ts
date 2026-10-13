/**
 * Agent 虚拟鼠标 overlay content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.cursor = { move, click, hold, releaseHold, hide, highlight, mark, clearMarks, for(id) }。
 * mark 标注挂在独立的 absolute host（文档坐标）。window 滚动靠文档坐标天然跟随；
 * 内部滚动容器不会改 window.scroll，必须在 scroll 捕获期按锚定元素的最新
 * getBoundingClientRect 重算。resize / visualViewport 同路径重算 mark 与拿住态光标；
 * 高亮只在 viewport 尺寸变化时收起（滚动不拆瞬时层）。
 * 就地确认（C 案）：mark 带 actions 时，光标飞到目标拿住（hold），
 * 持久按住不 park，名牌保持成员色并内嵌「确认红 / 取消灰」双键；松开走 releaseHold。
 * 默认实例（名牌 "SideAgent"）供单任务使用；for(id) 返回实例专属光标（名册上的人），
 * 为多任务并行准备的渲染层——每个并行 Agent 一个名字和颜色。
 *
 * shadow DOM（closed）隔离页面样式；host pointer-events:none + 最高 z-index，不干扰页面交互。
 * 坐标均为视口坐标系（与 Input.dispatchMouseEvent / getBoundingClientRect 一致）。
 *
 * 视觉参考：tldraw 协作光标（彩色填充 + 白描边 + 深色外晕 + 名牌 pill）、ChatGPT Agent（点击波纹）。
 * 轨迹：浅弧（ghost-cursor 一侧弧去掉随机）+ Fitts 时长 + 欠阻尼弹簧进度（轻过冲再稳住）。
 * 闲着停角落，要点再飞过去；不 3 秒隐掉。
 * 箭头形状取自 lucide MousePointer2（ISC）。
 *
 * 生命周期：MV3 扩展 reload 会销毁 isolated world 但留下 DOM host。启动时若本 world
 * 还没有 cursor API，按 data-sideagent-overlay 清掉旧 host 再创建。
 */
import { isMarkActionId, resolveImplicitMarkActions } from "../shared/mark-actions.js";
import { markLabelPlacement } from "../shared/mark-label.js";
import type { MarkAction } from "../../../shared/protocol.js";
import { cursorColor, LEAD_CURSOR_ID } from "../shared/palette.js";
import { mountGrok, mountKenney } from "../shared/grok-bot.js";
import { displayNameFor, personFor } from "../../../shared/cast.js";
import { cursorLabelPosition, type CursorLabelPlacement } from "../shared/cursor-label.js";
import {
  CURSOR_ARROW_PATH,
  CURSOR_STROKE_HALO,
  CURSOR_STROKE_WHITE,
  CURSOR_SVG_SIZE,
  CURSOR_TIP,
} from "../shared/cursor-visual.js";
import {
  PARK_AFTER_MS,
  flightMs,
  pointOnArc,
  restOnRight,
  restPoint,
  springFor,
  springSettled,
  springStep,
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
import { sketchFrame, sketchLabelPosition } from "../shared/rough/index.js";
import { beginFeedbackPill, feedbackLifetimeMs, type FeedbackPillState, type FeedbackPillView } from "../shared/feedback-pill.js";
import { EFFECT_SETTLE_MAX_MS } from "../../../shared/effect.js";

(function () {
  const ns = (window.__sideagent ??= {});

  // 同一 world 重复注入：保留现有实例。新 world（扩展 reload）先清旧 DOM 再挂。
  if (!ns.cursor) sweepStaleOverlayHosts(document);

  if (ns.cursor) return;

  const SCALE = CURSOR_SVG_SIZE / 24;
  const DEFAULT_ID = LEAD_CURSOR_ID;
  const DEFAULT_LABEL = "By Your Side";

  /** 状态文案与颜色是页面侧的唯一来源，background 只给状态名与目标标签页。 */
  const STATUS_COPY: Record<CursorStatusState, { text: string; sub?: string; color: string; autoHideMs?: number }> = {
    waiting: { text: "处理中", color: "#f59e0b" },
    reading: { text: "正在读这个页面", color: "#2d4a86" },
    done: { text: "本轮已结束", color: "#16a34a", autoHideMs: 1500 },
    failed: { text: "这一步没做成", sub: "可以让我重试", color: "#e2554f" },
  };

  interface Instance {
    el: HTMLDivElement;
    color: string;
    visible: boolean;
    restIndex: number;
    pos: { x: number; y: number };
    /** 最近一次飞向的点：助手的真实鼠标事件落在这里，用来和用户自己动鼠标区分。 */
    aim?: { x: number; y: number };
    resting: boolean;
    raf?: number;
    parkTimer?: ReturnType<typeof setTimeout>;
    labelAnimation?: Animation;
    labelPlacement?: CursorLabelPlacement;
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
    hold?: { point: { x: number; y: number }; target?: string; anchor: Element | null; name: string; mark?: HTMLDivElement; /** 教学：停在目标右下角，不压住目标中间。 */ corner?: boolean };
  }

  type CursorStatusState = "waiting" | "reading" | "done" | "failed";

  interface CursorStatus {
    state: CursorStatusState;
    text: string;
    /** 状态详情只采用已知信息，不在页面重复累计等待秒数。 */
    detail: string;
    sub: string;
    autoHideMs?: number;
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
    /** 画框时的目标：单个节点，或 mark 带 through 时从起点到终点的 Range。 */
    observedNode?: Node | Range;
    target?: string;
    pad: number;
    label?: string;
    options?: MarkOptions;
    seed?: number;
    /** 手绘框线按这个目标尺寸画的；目标变宽变高后重画框线、重摆名牌。 */
    drawn?: { w: number; h: number };
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

  /** 静态 SVG 构造：避免拼 innerHTML；属性与原模板一致。 */
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);

    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));

    return node;
  }

  function ensureDom(): void {
    if (host) return;
    // @property 声明放在 ShadowRoot 内不会在所有 Chromium 版本注册到文档。
    // 使用专属名称显式注册，旧版浏览器仍保留静态彩边作为降级。
    try {
      CSS.registerProperty({ name: "--sideagent-border-angle", syntax: "<angle>", inherits: false, initialValue: "0deg" });
    } catch { /* 已注册或不支持时继续使用静态边框。 */ }
    host = document.createElement("div");
    host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_CURSOR);
    host.setAttribute("aria-label", "助手操作与状态");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .cursor {
        position: absolute; top: 0; left: 0;
        transition: opacity 160ms ease;
      }
      /* 常驻的光标闲置时不长期占用独立合成层。 */
      .cursor:not(.rest) { will-change: transform; }
      .cursor.hidden { opacity: 0; }
      /* 贴边柔光（10-13 用户选定 A）：墨蓝从视口边缘向内晕开，一段亮光沿边慢走；
         参照 Gemini in Chrome / ego 的边框光。用户动鼠标时整层让位到很淡。 */
      .edge {
        position: absolute; inset: 0; pointer-events: none;
        opacity: 0; transition: opacity 600ms cubic-bezier(.16,1,.3,1);
        box-shadow: inset 0 0 0 1px rgba(45,74,134,.30), inset 0 0 16px 1px rgba(52,88,160,.20),
          inset 0 0 46px 6px rgba(80,120,200,.10);
      }
      .edge::before {
        content: ""; position: absolute; inset: 0; padding: 3px;
        background: conic-gradient(from var(--sideagent-border-angle, 0deg),
          transparent 0deg, transparent 230deg, rgba(96,140,225,0) 250deg,
          rgba(96,140,225,.85) 300deg, rgba(160,195,255,.95) 318deg,
          rgba(96,140,225,0) 345deg, transparent 360deg);
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        mask-composite: exclude;
        filter: blur(4px);
      }
      .edge.on { opacity: 1; }
      .edge.on::before { animation: soft-border-flow 6.5s linear infinite; }
      :host(.user-active) .edge.on { opacity: .18; transition-duration: 250ms; }
      :host(.user-active) .cursor:not(.holding):not(.guiding):not(.hidden) { opacity: .3; }
      :host(.user-active) .cursor:not(.holding):not(.guiding):not(.hidden) .label { opacity: 0; }
      /* 新建即点亮：淡入由样式起点完成，不靠下一帧再改 class（后台页的下一帧可能很晚，晚到的改动会让已发出的确认判为页面已变）。 */
      @starting-style { .edge.on { opacity: 0; } }
      @keyframes soft-border-flow { to { --sideagent-border-angle: 360deg; } }
      @media (prefers-reduced-motion: reduce) { .edge { transition: none; } .edge::before { animation: none !important; } }
      .cursor.rest { opacity: .78; }
      .cursor.rest .label { opacity: 0; }
      .cursor.flip .label { left: auto; right: ${Math.round(CURSOR_SVG_SIZE * 0.51)}px; }
      .svg-wrap {
        position: absolute; left: 0; top: 0;
        transition: transform 130ms ease;
        transform-origin: ${(CURSOR_TIP.x * SCALE).toFixed(1)}px ${(CURSOR_TIP.y * SCALE).toFixed(1)}px;
      }
      .cursor.pressing .svg-wrap { transform: scale(.8); }
      .cursor svg {
        position: absolute; display: block; overflow: visible;
        left: ${(-CURSOR_TIP.x * SCALE).toFixed(1)}px; top: ${(-CURSOR_TIP.y * SCALE).toFixed(1)}px;
        filter: drop-shadow(0 0 1px #fff) drop-shadow(0 1px 3px rgba(20,20,19,.32));
      }
      .cursor path.fill { fill: var(--c); }
      .cursor path.halo { fill: none; }
      .label {
        position: absolute; left: ${Math.round(CURSOR_SVG_SIZE * 0.63)}px; top: ${Math.round(CURSOR_SVG_SIZE * 0.69)}px;
        padding: 2px 9px; border-radius: 999px;
        background: var(--c); color: #fff;
        font: 600 12px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: .02em; white-space: nowrap;
        box-shadow: 0 0 0 1px rgba(255,255,255,.7), 0 2px 8px rgba(15,23,42,.35);
        text-shadow: 0 1px 1px rgba(15,23,42,.35);
        transition: opacity 160ms ease;
        pointer-events: none;
      }
      /* 光标旁的话：白底轻卡，左上角收尖，像从光标说出来；左边一颗小光球是我们的记号。 */
      .cursor.acting .label, .cursor.stating .label {
        display: inline-flex; align-items: center; gap: 7px;
        background: #ffffff; color: #141413;
        border: 1px solid rgba(20,20,19,.08); border-radius: 4px 12px 12px 12px;
        padding: 6px 12px 6px 9px;
        width: max-content; max-width: min(260px, calc(100vw - 16px)); box-sizing: border-box;
        font: 400 13px/1.45 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        letter-spacing: 0; white-space: normal; overflow-wrap: anywhere;
        text-shadow: none; opacity: 1;
        box-shadow: 0 4px 14px rgba(20,20,19,.10);
      }
      .orb-dot {
        flex: none; width: 10px; height: 10px; border-radius: 50%;
        background: radial-gradient(circle at 35% 35%, #f0abfc, #818cf8 72%);
        box-shadow: 0 0 6px rgba(129,140,248,.45);
        animation: orb-breathe 2.4s ease-in-out infinite;
      }
      @keyframes orb-breathe { 50% { transform: scale(.82); opacity: .75; } }
      @media (prefers-reduced-motion: reduce) { .orb-dot { animation: none; } }
      .action-text { display: block; }
      .agent-name { display: none; }
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
      /* 跨页入口：角色身份与页面位置，不遮挡阅读的大通知。 */
      .xpage {
        position: absolute; right: 20px; top: 20px; display: none;
        max-width: min(280px, calc(100vw - 40px)); pointer-events: auto;
        color: #141413; font: 400 12px/1.5 -apple-system, "PingFang SC", sans-serif;
      }
      .xpage.on { display: block; }
      /* 状态统一在右上角；光标旁只挂「正在做的这一下」（#43），做完随光标回角落收起。 */
      .cursor:not(.holding):not(.acting) .label { display: none !important; }
      /* 主助手停靠时可见；多个协作光标闲置时仍收起，以免挡住正文。 */
      .cursor.rest:not(.holding):not([data-primary="true"]) { visibility: hidden; }
      .cursor.holding .label { display:flex; flex-wrap:wrap; gap:6px; width:170px; max-width:calc(100vw - 48px); background:#ffffff; color:#141413; border:1px solid #e3e1d9; border-radius:8px; padding:8px 10px; box-shadow:0 2px 8px #2928210d; }
      .hold-prompt { flex-basis:100%; font-size:12px; white-space:normal; }
      .hold-action.confirm { background:#141413; color:#fff; }
      .hold-action.cancel { background:#f0eee6; color:#514b42; }
      .hold-action:focus-visible { outline:2px solid #2d4a86; outline-offset:2px; }
      .xdetail { color:inherit; font-size:11px; padding:8px; overflow-wrap:anywhere; }
      .xdetail[hidden] { display:none; }
      .xpage button {
        font: inherit; color: inherit; cursor: pointer; display: flex; align-items: center;
        gap: 7px; min-width: 0; width: 100%; box-sizing: border-box;
        background: #ffffff; border: 1px solid #e3e1d9; border-radius: 20px;
        padding: 6px 10px; box-shadow: 0 2px 8px #2928210d;
      }
      .xpage button:hover { background: #f0eee6; }
      .xpage button:focus-visible { outline: 2px solid #2d4a86; outline-offset: 3px; }
      .xface { display: inline-flex; width: 22px; height: 22px; flex-shrink: 0; align-items:center; justify-content:center; }
      .xface svg { width: 22px; height: 22px; }
      .xface .kn { position:relative; display:block; background:var(--body) center / contain no-repeat; }
      .xface .kn i { position:absolute; left:18%; right:18%; top:24%; bottom:30%; background:var(--face) center / contain no-repeat; }
      .xmain { white-space: nowrap; flex-shrink: 0; font-weight: 500; }
      /* 右上角只管停：小光球、名字、一个「停下」。 */
      .xbar {
        display: inline-flex; align-items: center; gap: 8px; float: right;
        background: #ffffff; border: 1px solid rgba(20,20,19,.08); border-radius: 999px;
        padding: 5px 5px 5px 11px; box-shadow: 0 2px 8px rgba(20,20,19,.06);
      }
      .xbar .xmain { font-weight: 400; color: #5f5e58; }
      .xpage .xbar .xstop {
        width: auto; padding: 3px 12px; border-radius: 999px; box-shadow: none;
        background: #ffffff; border: 1px solid rgba(20,20,19,.14); color: #141413; font: inherit;
      }
      .xpage .xbar .xstop:hover:not(:disabled) { background: #f0eee6; }
      .xpage .xbar .xstop:disabled { color: #77756d; cursor: default; }
      .xsub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #5f5e58; }
      .xarrow { margin-left: auto; }
      .xlist { margin-top: 6px; padding: 5px; border: 1px solid #e3e1d9; border-radius: 12px; background: #ffffff; max-height: 240px; overflow-y:auto; }
      .xlist {
        transform-origin: top right;
        opacity: 1; transform: scale(1);
        transition: opacity 250ms cubic-bezier(.22,1,.36,1), transform 250ms cubic-bezier(.22,1,.36,1), display 250ms allow-discrete;
      }
      .xlist[hidden] { display:none; opacity:0; transform:scale(.97); transition-duration:150ms; }
      @starting-style { .xlist:not([hidden]):not([data-restored]) { opacity:0; transform:scale(.97); } }
      @media(prefers-reduced-motion:reduce) { .xlist { transition:none; } }
      .xlist button { border:0; border-radius:7px; box-shadow:none; }
      @media(prefers-color-scheme:dark) {
        .xpage { color:#ece8df; }
        .xpage button, .xlist { background:#282720; border-color:#49463d; }
        .xpage button:hover { background:#343229; }
        .xsub { color:#c0bbaf; }
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
        border-width: 2px; box-shadow: none;
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
      /* 交给用户时的圈：填好、点过就淡出。 */
      .mark.handoff { transition: opacity .35s ease; }
      .mark.handoff.faded { opacity: 0; }
      @media (prefers-reduced-motion: reduce) {
        .mark.handoff { transition: none; }
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

  /** 主光标在右下角长期停靠；其他成员继续使用原有交错停靠点。 */
  function homeFor(index: number, primary: boolean): { x: number; y: number } {
    if (!primary) return restPoint(index, window.innerWidth);

    return { x: Math.max(28, window.innerWidth - 41), y: Math.max(48, window.innerHeight - 102) };
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

      // 教学的光标正在飞往目标：交给 relayoutHolds 决定要不要改航线，不在这里打断。
      if (!inst.hold?.corner) cancelFly(inst);

      if (inst.visible && !inst.hold) {
        const home = homeFor(inst.restIndex, inst.el.dataset.primary === "true");
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

        if (node instanceof Range ? !node.startContainer.isConnected : !node.isConnected) {mark.el.style.visibility = "hidden";continue;}

        let rect: DOMRect;

        if (node instanceof Range) rect = node.getBoundingClientRect();
        else if (node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();range.selectNodeContents(node);rect = range.getBoundingClientRect();
        } else rect = (node as Element).getBoundingClientRect();
        mark.el.style.visibility = rect.width && rect.height ? "" : "hidden";
        placeMark(mark, rect);
        continue;
      }

      const anchor = liveAnchor(mark);

      if (!anchor) {
        mark.el.style.visibility = "hidden";
        continue;
      }

      mark.el.style.visibility = "";
      const r = anchor.getBoundingClientRect();
      placeMark(mark, { x: r.x, y: r.y, width: r.width, height: r.height });
    }
  }

  function placeMark(mark: LiveMark, rect: SideAgentRect): void {
    applyMarkBox(mark.el, rect, mark.pad, mark.label);

    if (!mark.drawn || !rect.width || !rect.height) return;

    if (Math.abs(mark.drawn.w - rect.width) <= 1 && Math.abs(mark.drawn.h - rect.height) <= 1) return;
    mark.drawn = { w: rect.width, h: rect.height };
    const frame = drawSketchPaths(mark.el, { x: mark.pad, y: mark.pad, w: rect.width, h: rect.height }, mark.seed ?? 1);
    const labelEl = mark.el.querySelector<HTMLElement>(".sketch-label");
    const handoff = handoffMarks.find((m) => m.el === mark.el);

    if (labelEl && handoff) placeHandoffLabel(handoff, labelEl, frame);
    else if (labelEl) placeSketchLabel(mark.el, labelEl, frame);
  }

  /** 拿住期间手跟目标走：若锚点有效则跟随目标最新位置；若锚点暂不可解（如 AX ref 或外部滚动），保持当前拿住点不误隐藏。 */
  function relayoutHolds(): void {
    for (const inst of instances.values()) {
      const hold = inst.hold;

      if (!hold) continue;
      const anchor = liveAnchor(hold);
      const before = hold.point;

      if (anchor) hold.point = holdPoint(anchor.getBoundingClientRect(), hold.corner);

      if (inst.visible) inst.el.classList.remove("hidden");

      // 教学的光标还在飞：画圈时常跟着一次尺寸没变的 resize，直接跳到终点就看不到它飞过去了。
      if (hold.corner && inst.raf !== undefined) {
        if (Math.hypot(hold.point.x - before.x, hold.point.y - before.y) > 1) flyTo(inst, hold.point);
        continue;
      }

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
    const svgWrap = document.createElement("div");
    svgWrap.className = "svg-wrap";
    const cursorSvg = svgEl("svg", { width: CURSOR_SVG_SIZE, height: CURSOR_SVG_SIZE, viewBox: "0 0 24 24" });
    cursorSvg.append(
      svgEl("path", { class: "halo", d: CURSOR_ARROW_PATH, fill: "none", stroke: "#0f172a", "stroke-width": CURSOR_STROKE_HALO, "stroke-linejoin": "round" }),
      svgEl("path", { class: "fill", d: CURSOR_ARROW_PATH, stroke: "#ffffff", "stroke-width": CURSOR_STROKE_WHITE, "stroke-linejoin": "round" }),
    );
    svgWrap.appendChild(cursorSvg);
    const nameLabel = document.createElement("div");
    nameLabel.className = "label";
    nameLabel.textContent = id === DEFAULT_ID ? DEFAULT_LABEL : displayNameFor(id);
    el.replaceChildren(svgWrap, nameLabel);
    const color = cursorColor(id);
    el.style.setProperty("--c", color);
    el.dataset.primary = String(id === DEFAULT_ID);
    shadow!.appendChild(el);
    const restIndex = instances.size;
    const home = homeFor(restIndex, id === DEFAULT_ID);

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
    const p = cursorLabelPosition(inst.pos, size, { width: window.innerWidth, height: window.innerHeight }, inst.action.rect, inst.labelPlacement);
    inst.labelPlacement = p.placement;
    label.style.left = `${p.x - inst.pos.x}px`;
    label.style.top = `${p.y - inst.pos.y}px`;
  }

  function clearAction(inst: Instance): void {
    inst.labelAnimation?.cancel();
    inst.labelAnimation = undefined;
    inst.action = undefined;
    inst.labelSize = undefined;
    inst.labelPlacement = undefined;
    inst.el.classList.remove("acting");
    inst.highlightEl?.remove();
    inst.highlightEl = undefined;
    refreshLabel(inst);
    renderAmbient();
  }

  /** 名牌正文渲染：动作与状态共用同一块牌子。 */
  function paintLabel(inst: Instance, main: string, sub: string): void {
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    const orb = document.createElement("span");
    orb.className = "orb-dot";
    orb.setAttribute("aria-hidden", "true");
    const line = document.createElement("span");
    line.className = "action-text";
    line.textContent = main;
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = sub;
    inst.labelAnimation?.cancel();
    inst.labelAnimation = undefined;
    label.replaceChildren(orb, line, name);
    inst.labelSize = undefined;
    inst.labelPlacement = undefined;
    positionActionLabel(inst);

    // A「纸面」：整句一次淡入；只描绘操作回执，不展示未经核验的页面事实。
    if (inst.action && !reducedMotion.matches) {
      inst.labelAnimation = label.animate(
        [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 160, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    }
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

  /** 光标旁一句人话，最多 12 个字：「我在填「出发日期」」「点好了」。 */
  function renderActionLabel(inst: Instance): void {
    const action = inst.action!;
    const verb = { click: "点", fill: "填", hover: "看" }[action.kind];
    const name = action.name.length > 6 ? `${action.name.slice(0, 5)}…` : action.name;

    // 按钮名加引号免得和动词连读（「我在点「查询车票」」）；栏名本身就是名词，不加。
    const target = action.kind === "click" ? `「${name}」` : name;

    const text = action.phase === "active" ? (name ? `我在${verb}${target}` : { click: "我在点这里", fill: "我在填这一栏", hover: "我在看这里" }[action.kind])
      : action.phase === "failed" ? "没做成"
      : action.phase === "unknown" ? "结果未知"
      : `${verb}好了`;

    paintLabel(inst, text, "");
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
    if (inst.status?.clearTimer !== undefined) clearTimeout(inst.status.clearTimer);
  }

  function startStatusTimers(inst: Instance): void {
    const status = inst.status!;
    const copy = STATUS_COPY[status.state];
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
      autoHideMs: view.autoHideMs,
    };

    if (!inst.visible) showAtRest(inst);

    // 失败停在原地等处理：取消自动回角落，别把出错位置挪走
    if (view.state === "failed") {
      clearTimeout(inst.parkTimer);
      setResting(inst, false);
    }

    startStatusTimers(inst);

    // 拿住态与正在说的动作旁白优先：状态先记下，等它们结束再画
    refreshLabel(inst);
    renderAmbient();
  }

  function clearStatusInst(inst: Instance): void {
    if (!inst.status) return;
    clearStatusTimers(inst);
    inst.status = undefined;
    refreshLabel(inst);
    renderAmbient();
  }

  function cancelFly(inst: Instance): void {
    if (inst.raf !== undefined) {
      cancelAnimationFrame(inst.raf);
      inst.raf = undefined;
    }
  }

  function showAtRest(inst: Instance): void {
    const home = homeFor(inst.restIndex, inst.el.dataset.primary === "true");
    setPos(inst, home);
    setResting(inst, true);
    inst.el.classList.remove("hidden");
    inst.visible = true;
  }

  function flyTo(inst: Instance, to: { x: number; y: number }): number {
    cancelFly(inst);
    inst.aim = to;
    const from = inst.pos;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);

    if (dist < 2 || reducedMotion.matches) {
      setPos(inst, to);

      if (inst.action) inst.action.arrived = true;

      return 0;
    }

    const ms = flightMs(from, to);
    const spring = springFor(ms);
    let s = 0;
    let v = 0;
    let last = performance.now();
    let elapsed = 0;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      elapsed += dt * 1000;
      [s, v] = springStep(s, v, dt, spring);
      setPos(inst, pointOnArc(from, to, s));

      if (!springSettled(s, v) && elapsed < ms * 2) inst.raf = requestAnimationFrame(tick);
      else {
        inst.raf = undefined;

        if (inst.action) inst.action.arrived = true;
        setPos(inst, to);
      }
    };

    inst.raf = requestAnimationFrame(tick);

    return ms;
  }

  function schedulePark(inst: Instance, delay = PARK_AFTER_MS): void {
    clearTimeout(inst.parkTimer);
    inst.parkTimer = setTimeout(() => parkNow(inst), delay);
  }

  /** 纸面气泡收完之后，统一回本分支的右下角常驻位置。 */
  function finishPark(inst: Instance): void {
    if (inst.action?.phase === "done") clearAction(inst);
    const home = homeFor(inst.restIndex, inst.el.dataset.primary === "true");
    setResting(inst, true);
    flyTo(inst, home);
  }

  /** 保持动作结果约两秒，然后淡出 200ms；新动作取消旧回调。 */
  function parkNow(inst: Instance): void {
    if (inst.action?.phase === "active" || inst.hold) return;
    if (!inst.action || reducedMotion.matches) { finishPark(inst); return; }

    const actionId = inst.action.id;
    const label = inst.el.querySelector<HTMLDivElement>(".label")!;
    inst.labelAnimation?.cancel();
    const animation = label.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-3px)" }],
      { duration: 200, easing: "ease-out", fill: "forwards" },
    );
    inst.labelAnimation = animation;
    animation.onfinish = () => {
      if (inst.labelAnimation !== animation || inst.action?.id !== actionId) return;
      finishPark(inst);
    };
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

  /** 视口里这块区域下面有没有页面内容（文字、图片、控件）；标注层和光标层不参与命中。 */
  function coversPageContent(r: { x: number; y: number; w: number; h: number }): boolean {
    const seen = new Set<Element>();

    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 2; j++) {
        const px = r.x + 1 + ((r.w - 2) * i) / 4;
        const py = r.y + 1 + ((r.h - 2) * j) / 2;
        const hit = document.elementsFromPoint(px, py).find((e) => !e.closest(`[${OVERLAY_ATTR}]`));

        if (!hit || seen.has(hit)) continue;
        seen.add(hit);

        if (hit.matches("img,svg,video,canvas,input,textarea,select,button,iframe")) return true;

        for (const node of hit.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);

          for (const t of range.getClientRects()) {
            if (Math.min(t.right, r.x + r.w) > Math.max(t.left, r.x) && Math.min(t.bottom, r.y + r.h) > Math.max(t.top, r.y)) return true;
          }
        }
      }
    }

    return false;
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
    const prompt = document.createElement("span");
    prompt.className = "hold-prompt";
    prompt.textContent = "要做这一步吗？";
    labelEl.appendChild(prompt);
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
    inst.el.classList.remove("pressing", "holding", "guiding");
    delete inst.el.dataset.armed;

    // 确认锚框跟着拿住态一起走：用户确认/取消或动作换手后，"待确认"不该留在页面上
    if (hold.mark) removeMark(hold.mark);
    refreshLabel(inst);
    renderAmbient();
  }

  /** 拿住时手放在哪：确认放目标中间；教学放右下角，箭头尖落在目标边上，不挡住要点的字。 */
  function holdPoint(r: SideAgentRect, corner?: boolean): { x: number; y: number } {
    return corner ? { x: Math.round(r.x + r.width - 6), y: Math.round(r.y + r.height - 6) } : { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  /**
   * 拿住：飞到目标点进入持久按住态（不弹回、不 park、rest/flip 不藏名牌）。
   * 带 actions 时名牌变双键；教学（actions 为 null）只停在目标右下角，不显示名牌、没有按钮。
   */
  function holdInst(
    inst: Instance,
    x: number,
    y: number,
    actions: MarkAction[] | null,
    target?: string,
    anchorMark?: HTMLDivElement | null,
    guideAnchor?: Element,
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
      anchor: guideAnchor ?? resolveAnchor({ x: x - 1, y: y - 1, width: 2, height: 2 }, target),
      name,
      mark: anchorMark ?? undefined,
      corner: guideAnchor ? true : undefined,
    };

    // 教学不挂名牌（guiding 不显示 .label）：说明写在圈旁，光标旁再多一块牌子只会挡住页面。
    if (actions) {
      armHoldLabel(inst, actions);
      inst.el.classList.add("pressing", "holding");
    } else inst.el.classList.add("guiding");
    renderAmbient();
    flyTo(inst, { x, y });
  }

  // ── 教学一步（guide_step，docs/evals/20261011-guided-teaching.md）────────────
  // 圈出目标、光标停在右下角，等用户自己点。点击只听不拦：捕获期先看到，不阻止网页自己处理。
  // 后台通过 port 等结果；port 断开（后台结束、停下、离开）就收场，所以每条结束路径都走 endGuide。

  interface GuideSession {
    inst: Instance;
    node: Node;
    target: string;
    /** 网页重画目标后，在页面里重新找到它的定位串。@ref 只对快照有效，页面里找不回，所以开始时换成能找回同一个元素的定位串。 */
    relocate: string | null;
    name: string;
    options?: MarkOptions;
    mark: HTMLDivElement | null;
    label: string;
    /** 目标最后一次量到的位置：目标被换掉、新节点又找不到时，按这里判断点中没有。 */
    rect: DOMRect | null;
    port: chrome.runtime.Port;
    observer: MutationObserver;
    misses: number;
    /** 点错以后，用户下一次移动鼠标时光标让开。 */
    missed: boolean;
    /** 网页上次变化（不算助手自己的浮层）的时刻。 */
    lastChange: number;
    down: { at: number; url: string } | null;
    /** 松开后等 click：网页在按下时把目标整块重画，浏览器就不发 click，这时按松开算这一下。 */
    upTimer?: ReturnType<typeof setTimeout>;
    /**
     * 点中以后在看页面有没有变化。settled：3 秒没变化、提示已经出了，仍接着看到用户下一次按下：
     * 慢的网页晚一点才变，也算这次点中生效。
     */
    watch: { since: number; url: string; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval>; settled: boolean } | null;
  }

  let guide: GuideSession | null = null;

  const GUIDE_NO_CHANGE_TEXT = "点了之后，页面没有变化。再点一次。如果还是没变化，就在侧栏告诉我。";

  /** 按下到松开超过这么久就不算同一次点：只把这段时间里网页的变化算给这次点击（有的网页在按下时就切换）。 */
  const GUIDE_PRESS_MS = 1500;

  /** 点完以后告诉模型的目标状态：开关、标签、展开这些状态，模型据此知道这一步已经生效，不再让用户点一遍。 */
  const GUIDE_STATES = ["aria-checked", "aria-selected", "aria-expanded", "aria-pressed"];

  function guideMissText(name: string): string {
    return name ? `这里不是要点的地方。点圈出来的「${name}」。` : "这里不是要点的地方。点圈出来的地方。";
  }

  function guideElement(node: Node): Element | null {
    return node instanceof Element ? node : node.parentElement;
  }

  function nodeRect(node: Node): DOMRect | null {
    if (!node.isConnected) return null;
    let r: DOMRect;

    if (node instanceof Element) r = node.getBoundingClientRect();
    else {
      const range = document.createRange();
      range.selectNodeContents(node);
      r = range.getBoundingClientRect();
    }

    return r.width && r.height ? r : null;
  }

  function guideRole(el: Element): string {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];

    if (explicit) return explicit;
    const type = el instanceof HTMLInputElement ? el.type : "";

    if (el.matches("button, input[type=button], input[type=submit]")) return "button";
    if (el.matches("a[href]")) return "link";
    if (type === "checkbox" || type === "radio") return type;
    if (el instanceof HTMLSelectElement) return "combobox";

    return "";
  }

  /** CSS 路径：从最近的带 id 祖先（或 body）往下按 nth-of-type 走。网页按原样重画时，新节点还在同一个位置。 */
  function guideCssPath(el: Element): string {
    const parts: string[] = [];

    for (let at: Element | null = el; at && at !== document.body && at !== document.documentElement; at = at.parentElement) {
      if (at.id && at !== el) { parts.unshift(`#${CSS.escape(at.id)}`); break; }
      const tag = at.tagName.toLowerCase();
      const same = at.parentElement ? [...at.parentElement.children].filter((c) => c.tagName === at!.tagName) : [at];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(at) + 1})` : tag);
    }

    return parts.join(" > ");
  }

  /** @ref 换成页面里能找回同一个元素的定位串：按角色和名字、id、CSS 路径依次试，只留此刻确实找回它本身的那个。 */
  function guideLocator(node: Node, target: string): string | null {
    if (!target.startsWith("@")) return target;
    const el = guideElement(node);
    const dom = window.__sideagent?.dom;

    if (!el || !dom) return null;
    const role = guideRole(el);
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
    const candidates = [role && name && !name.includes('"') ? `loc=role:${role}[name="${name}"]` : "", el.id ? `#${CSS.escape(el.id)}` : "", guideCssPath(el)];

    for (const candidate of candidates) {
      if (!candidate) continue;

      try {
        if (dom.resolve(candidate) === el) return candidate;
      } catch { /* 这个定位串找不到或不唯一：试下一个 */ }
    }

    return null;
  }

  /** 网页重画了目标：用定位串重新找一次，找不回就留着旧节点。 */
  function liveGuideNode(g: GuideSession): Node {
    if (g.node.isConnected || !g.relocate) return g.node;

    try {
      const fresh = window.__sideagent?.dom?.resolve?.(g.relocate);

      if (fresh) g.node = fresh;
    } catch { /* 找不到：保留旧节点 */ }

    return g.node;
  }

  function drawGuideMark(g: GuideSession, label: string): void {
    g.label = label;

    if (g.mark) removeMark(g.mark);
    const node = liveGuideNode(g);
    const r = nodeRect(node);

    if (r) g.rect = r;
    g.mark = r ? spawnMark(g.inst, r, label, g.target, g.options, node) : null;
  }

  function holdAtGuide(g: GuideSession): void {
    const node = liveGuideNode(g);
    const el = guideElement(node);
    const r = nodeRect(node);

    if (!el || !r) return;
    const p = holdPoint(r, true);
    holdInst(g.inst, p.x, p.y, null, g.relocate ?? undefined, null, el);
  }

  /** 等用户点的时候目标被换成新节点：圈和光标跟到新节点上。 */
  function followGuideNode(g: GuideSession): void {
    const before = g.node;

    if (before.isConnected || liveGuideNode(g) === before) return;
    drawGuideMark(g, g.label);

    if (g.inst.hold?.corner) holdAtGuide(g);
  }

  function postGuide(g: GuideSession, message: Record<string, unknown>): void {
    try { g.port.postMessage(message); } catch { /* 后台已断开：onDisconnect 收场 */ }
  }

  /** 页面变化里去掉助手自己的浮层（光标、圈、确认框都挂在带 OVERLAY_ATTR 的 host 上）。 */
  function pageMutated(records: MutationRecord[]): boolean {
    const own = (n: Node) => n instanceof Element && n.hasAttribute(OVERLAY_ATTR);

    return records.some((r) => {
      if (guideElement(r.target)?.closest(`[${OVERLAY_ATTR}]`)) return false;

      return !(r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(own));
    });
  }

  /** 点完以后目标的样子：角色、名字、状态（不读输入框里的文字），最多 120 字。 */
  function guideAfter(g: GuideSession): string | undefined {
    const el = guideElement(liveGuideNode(g));

    if (!el?.isConnected) return undefined;
    const name = actionName(el).slice(0, 40);
    const states = GUIDE_STATES.flatMap((a) => (el.hasAttribute(a) ? [`${a}=${el.getAttribute(a)}`] : []));

    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) states.push(`checked=${el.checked}`);
    if (el instanceof HTMLSelectElement) states.push(`value="${(el.selectedOptions[0]?.textContent ?? "").trim().slice(0, 30)}"`);

    return [guideRole(el) || el.tagName.toLowerCase(), name ? `"${name}"` : "", ...states].filter(Boolean).join(" ").slice(0, 120);
  }

  function stopWatch(g: GuideSession): void {
    if (!g.watch) return;
    clearTimeout(g.watch.timer);
    clearInterval(g.watch.poll);
    g.watch = null;
  }

  function checkGuide(g: GuideSession): void {
    const w = g.watch;

    if (!w) return;
    const changed = location.href !== w.url ? "url" : g.lastChange >= w.since ? "dom" : null;

    if (!changed) return;
    const after = guideAfter(g);
    postGuide(g, { kind: "done", changed, ...(after ? { after } : {}), ...(changed === "url" ? { url: location.href } : {}) });
    endGuide(g);
  }

  function guideNoChange(g: GuideSession): void {
    const w = g.watch;

    if (!w || w.settled) return;
    w.settled = true;
    drawGuideMark(g, GUIDE_NO_CHANGE_TEXT);
    postGuide(g, { kind: "no_change" });
  }

  function onGuideDown(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted) return;
    g.down = { at: performance.now(), url: location.href };

    // 用户又按下了：上一次点击晚到的变化不再算给它，这一下重新判断。
    if (g.watch?.settled) stopWatch(g);
  }

  function onGuideMove(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted || !g.missed) return;
    g.missed = false;

    // 让开：松开、回停靠位，圈留在原处。
    if (g.inst.hold?.corner) {
      releaseHoldInst(g.inst);
      finishPark(g.inst);
    }
  }

  function onGuideUp(ev: PointerEvent): void {
    const g = guide;

    if (!g || !ev.isTrusted || ev.button !== 0) return;
    clearTimeout(g.upTimer);
    // 事件路径只在派发期间可读：先记下。click 紧跟在松开后同步派发；到这个定时器时还没来，就是浏览器不会发了。
    const path = ev.composedPath();
    g.upTimer = setTimeout(() => onGuidePress(ev, path), 50);
  }

  function onGuideClick(ev: MouseEvent): void {
    if (!guide || !ev.isTrusted) return;
    clearTimeout(guide.upTimer);
    onGuidePress(ev, ev.composedPath());
  }

  function onGuidePress(ev: MouseEvent, path: EventTarget[]): void {
    const g = guide;

    if (!g || (g.watch && !g.watch.settled)) return;

    // 点在助手自己的浮层上（停止条、确认框）不算这一步的点击。
    if (path.some((n) => n instanceof Element && n.hasAttribute(OVERLAY_ATTR))) return;
    stopWatch(g);
    const node = liveGuideNode(g);
    const el = guideElement(node);
    const labels = el && "labels" in el ? [...((el as HTMLInputElement).labels ?? [])] : [];
    const onPath = (!!el && path.includes(el)) || labels.some((label) => path.includes(label));
    // 坐标只在没有事件路径、或目标被换掉又找不回时兜底：否则盖在目标上的东西（比如 cookie 横幅）也会被当成点中。
    const r = !node.isConnected || path.length === 0 ? nodeRect(node) ?? g.rect : null;
    const inside = !!r && ev.clientX >= r.left - 4 && ev.clientX <= r.right + 4 && ev.clientY >= r.top - 4 && ev.clientY <= r.bottom + 4;

    if (!onPath && !inside) {
      g.misses += 1;
      g.missed = true;
      drawGuideMark(g, guideMissText(g.name));
      holdAtGuide(g);
      postGuide(g, { kind: "miss", misses: g.misses });

      return;
    }

    // 先报「点中了」：点下去就换页时，后台据此把换文档算作完成。
    postGuide(g, { kind: "hit" });
    const now = performance.now();
    const pressed = g.down && now - g.down.at < GUIDE_PRESS_MS ? g.down : null;
    g.watch = {
      since: pressed?.at ?? now,
      url: pressed?.url ?? location.href,
      timer: setTimeout(() => guideNoChange(g), EFFECT_SETTLE_MAX_MS),
      poll: setInterval(() => checkGuide(g), 100),
      settled: false,
    };
    checkGuide(g);
  }

  /** 收场：撤圈、松开光标、摘掉监听。重复调用无害。 */
  function endGuide(g: GuideSession): void {
    if (guide !== g) return;
    guide = null;
    window.removeEventListener("click", onGuideClick, true);
    window.removeEventListener("pointerdown", onGuideDown, true);
    window.removeEventListener("pointermove", onGuideMove, true);
    window.removeEventListener("pointerup", onGuideUp, true);
    clearTimeout(g.upTimer);
    g.observer.disconnect();
    stopWatch(g);

    if (g.mark) removeMark(g.mark);
    g.mark = null;

    if (g.inst.hold?.corner) {
      releaseHoldInst(g.inst);
      schedulePark(g.inst);
    }
  }

  function startGuide(inst: Instance, node: Node, say: string, target: string, portName: string, options?: MarkOptions): { name: string } {
    if (guide) {
      const old = guide;
      endGuide(old);

      try { old.port.disconnect(); } catch { /* 已断开 */ }
    }

    const el = guideElement(node);
    const full = actionName(el ?? undefined);
    const port = chrome.runtime.connect({ name: portName });

    const g: GuideSession = {
      inst, node, target, options, port,
      relocate: guideLocator(node, target),
      name: full.length > 20 ? `${full.slice(0, 19)}…` : full,
      mark: null,
      label: say,
      rect: null,
      observer: new MutationObserver((records) => {
        if (!pageMutated(records)) return;
        g.lastChange = performance.now();
        checkGuide(g);

        if (guide === g) followGuideNode(g);
      }),
      misses: 0,
      missed: false,
      lastChange: -1,
      down: null,
      watch: null,
    };

    guide = g;
    port.onDisconnect.addListener(() => endGuide(g));
    g.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener("click", onGuideClick, true);
    window.addEventListener("pointerdown", onGuideDown, true);
    window.addEventListener("pointermove", onGuideMove, true);
    window.addEventListener("pointerup", onGuideUp, true);
    drawGuideMark(g, say);
    holdAtGuide(g);

    return { name: g.name };
  }

  function spawnMark(
    inst: Instance,
    rect: SideAgentRect,
    label?: string,
    target?: string,
    options?: MarkOptions,
    observedNode?: Node | Range,
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

    // 目标在外框里的位置：box 四周各留了 pad。
    const targetBox = { x: pad, y: pad, w: rect.width, h: rect.height };
    let frame = targetBox;

    if (isSketch) {
      const svg = svgEl("svg", { class: motion === "boil" ? "sketch-svg" : "sketch-svg anim-stroke-grow", style: "left:0;top:0;width:100%;height:100%;" });

      if (motion === "boil") {
        [0, 1, 2].forEach((i) => svg.appendChild(svgEl("path", { class: `boil-path sketch-frame-path frame-${i}`, "data-i": i })));
      } else svg.appendChild(svgEl("path", { class: "sketch-frame-path" }));

      el.replaceChildren(svg);
      frame = drawSketchPaths(el, targetBox, seed);

      if (label) {
        const markLabel = document.createElement("div");
        markLabel.className = "mark-label sketch-label";
        el.appendChild(markLabel);
      }
    } else {
      const svg = svgEl("svg", { class: "mark-arrow", width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" });
      svg.appendChild(svgEl("path", { d: "M2 12h17m-6-6 6 6-6 6", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      el.replaceChildren(svg);

      if (label) {
        const markLabel = document.createElement("div");
        markLabel.className = "mark-label";
        el.appendChild(markLabel);
      }
    }

    const labelEl = label ? el.querySelector<HTMLElement>(".mark-label") : null;

    if (labelEl && label) labelEl.textContent = label;
    applyMarkBox(el, rect, pad, label);
    marksLayer!.appendChild(el);

    if (labelEl && isSketch) placeSketchLabel(el, labelEl, frame);
    liveMarks.push({
      el,
      anchor: observedNode ? null : resolveAnchor(rect, target),
      observedNode,
      target,
      pad,
      label,
      options: opts,
      seed,
      drawn: isSketch ? { w: rect.width, h: rect.height } : undefined,
    });

    return el;
  }

  /** 按目标框（标注内坐标）画手绘框线：grow 一笔，boil 三帧；返回框线实际占的范围。 */
  function drawSketchPaths(el: HTMLElement, targetBox: { x: number; y: number; w: number; h: number }, seed: number) {
    const paths = [...el.querySelectorAll<SVGPathElement>(".sketch-frame-path")];
    const boil = paths.length > 1;
    let frame = targetBox;

    paths.forEach((path, i) => {
      const outline = sketchFrame(targetBox, boil ? { seed, roughness: 0.9, boil: 0.45, boilSeed: seed + (i + 1) * 7919 } : { seed, roughness: 0.9 });
      frame = outline.frame;
      path.setAttribute("d", outline.d);
    });

    return frame;
  }

  /** 名牌挂上之后才量得到真实大小；按标注当前的文档位置换算到视口，检查底下有没有页面文字。 */
  function placeSketchLabel(el: HTMLElement, labelEl: HTMLElement, frame: { x: number; y: number; w: number; h: number }): void {
    const size = labelEl.getBoundingClientRect();
    const originX = (parseFloat(el.style.left) || 0) - window.scrollX;
    const originY = (parseFloat(el.style.top) || 0) - window.scrollY;
    const toView = (b: { x: number; y: number; w: number; h: number }) => ({ x: originX + b.x, y: originY + b.y, w: b.w, h: b.h });

    const at = sketchLabelPosition(frame, { w: size.width, h: size.height }, {
      inView: (b) => {
        const v = toView(b);

        return v.x >= 4 && v.y >= 0 && v.x + v.w <= window.innerWidth - 4 && v.y + v.h <= window.innerHeight;
      },
      clear: (b) => !coversPageContent(toView(b)),
    });

    labelEl.style.left = `${at.left}px`;
    labelEl.style.top = `${at.top}px`;
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

  function waitReplay(inst: Instance, ms: number): Promise<void> {
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
      await waitReplay(inst, ms);

      if (inst.replayGen !== gen) return;

      if (p.click) {
        spawnRipple(to.x, to.y, "ripple", inst.color);
        spawnRipple(to.x, to.y, "ripple r2", inst.color);
        inst.el.classList.add("pressing");
        clearTimeout(inst.pressTimer);
        inst.pressTimer = setTimeout(() => inst.el.classList.remove("pressing"), 160);
        await waitReplay(inst, 180);
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
      /* 页面归你时：和「停下」同一个位置、同一种胶囊；光球变灰表示助手停着。 */
      .bar {
        position: absolute; right: 20px; top: 20px;
        display: inline-flex; align-items: center; gap: 8px;
        width: max-content; max-width: calc(100vw - 40px);
        pointer-events: none;
        background: #fff; color: #141413;
        border: 1px solid rgba(20,20,19,.08); border-radius: 999px; padding: 5px 5px 5px 11px;
        box-shadow: 0 2px 8px rgba(20,20,19,.06);
        font: 400 12px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        opacity: 0; transform: translateY(-6px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      /* 隐藏后仍在原处：不能接住点击，否则用户和 Agent 都点不到底下的网页。 */
      .bar.on { opacity: 1; transform: none; pointer-events: auto; }
      .bar::before {
        content: ""; flex: none; width: 10px; height: 10px; border-radius: 50%;
        background: radial-gradient(circle at 35% 35%, #f0abfc, #818cf8 72%); filter: grayscale(1); opacity: .55;
      }
      .bar b { font-weight: 400; color: #5f5e58; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
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
        font: 400 12px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
        border: 1px solid rgba(20,20,19,.14); border-radius: 999px; padding: 3px 12px;
        background: #fff; color: #141413; cursor: pointer;
      }
      .bar button:hover:not(:disabled) { background: #f0eee6; }
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
    ask?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    const bar = ensureControlDom();
    const status = bar.querySelector("b");
    const btn = bar.querySelector("button");
    let sub = bar.querySelector<HTMLElement>(".sub");
    let stack = bar.querySelector<HTMLElement>(".stack");

    // 助手交给用户时，用户要做的事直接写在「现在归你」后面（单个助手也显示）。
    if (status) status.textContent = view?.ask ? `${view.status || "现在归你"} · ${view.ask}` : view?.status || "现在归你";
    const subText = view?.sub?.trim() ?? "";

    const members = view?.members ?? [];
    // 只有一位助手时「1 个已暂停」和头像都是重复信息；多位时才列出。
    const team = members.length > 1;

    if (subText && team) {
      if (!sub) {
        sub = document.createElement("span");
        sub.className = "sub";
        status?.after(sub);
      }

      sub.textContent = subText;
    } else {
      sub?.remove();
    }

    if (team) {
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
    ask?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void {
    applyControlView(view);
    const bar = ensureControlDom();
    bar.classList.add("on");
  }

  function hideUserControl(): void {
    // 页面条收起 = 页面不再归用户：交给用户时画的圈一起清掉（docs/evals/20261012-handoff-circle.md R3）。
    clearHandoff();

    if (!controlBar) return;
    controlBar.classList.remove("on");
  }

  // ── 交给用户时的圈（docs/evals/20261012-handoff-circle.md）──────────────
  // 橙色表示「轮到你」；用户自己填好的栏、点过的按钮，圈就淡出。名牌只挂在还空着的第一栏和按钮上。

  const HANDOFF_COLOR = "#d2602a";

  const HANDOFF_INNER_FIELD = "input:not([type=button],[type=submit],[type=reset],[type=image],[type=hidden]),textarea,select,[contenteditable]:not([contenteditable=false])";

  /** node：模型给的目标；control：判断填没填的控件（包着输入框的 label、div 取里面第一个）。touched：交给用户以后用户自己动过它。 */
  interface HandoffMark { el: HTMLDivElement; node: Element; control: Element; kind: "field" | "button"; name: string; touched: boolean; done: boolean }

  let handoffMarks: HandoffMark[] = [];
  let handoffListening = false;

  function isHandoffField(el: Element): boolean {
    if (el instanceof HTMLInputElement) return !["button", "submit", "reset", "image"].includes(el.type);

    return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);
  }

  /** iframe 里面看不到，按要填的栏算、但不淡出；包着输入框的元素按里面第一个输入框算。 */
  function handoffKind(node: Element): { kind: "field" | "button"; control: Element } {
    if (isHandoffField(node) || node instanceof HTMLIFrameElement) return { kind: "field", control: node };

    if (node.matches("button,a,input,[role=button]")) return { kind: "button", control: node };
    const inner = node.querySelector(HANDOFF_INNER_FIELD);

    return inner ? { kind: "field", control: inner } : { kind: "button", control: node };
  }

  /** 只判断有没有值，不读出值。 */
  function isHandoffFilled(el: Element): boolean {
    if (el instanceof HTMLIFrameElement) return false;

    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value.trim() !== "";

    return (el.textContent ?? "").trim() !== "";
  }

  function addHandoffMark(inst: Instance, rect: SideAgentRect, target: string, options?: MarkOptions, observedNode?: Node): void {
    // 页面条没显示，说明页面已经不归用户（交还或停止抢在了前面）：不画。
    if (!controlBar?.classList.contains("on")) return;
    const node = observedNode instanceof Element ? observedNode : resolveAnchor(rect, target);

    if (!node || handoffMarks.some((m) => m.node === node)) return;
    const { kind, control } = handoffKind(node);
    // 已经有值的栏也圈（下拉框的默认值、浏览器自动填的）：用户自己改过才算填好。
    const el = spawnMark(inst, rect, undefined, target, { ...options, style: "sketch" }, observedNode);

    if (!el) return;
    el.style.setProperty("--c", HANDOFF_COLOR);
    el.classList.add("handoff");
    handoffMarks.push({ el, node, control, kind, name: actionName(control) || actionName(node), touched: false, done: false });

    if (!handoffListening) {
      handoffListening = true;
      window.addEventListener("input", onHandoffInput, true);
      window.addEventListener("change", onHandoffInput, true);
      window.addEventListener("click", onHandoffClick, true);
    }
  }

  /** 名牌下面有没有可操作的控件（文字不算）。 */
  function coversControl(r: { x: number; y: number; w: number; h: number }): boolean {
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 2; j++) {
        const hit = document.elementsFromPoint(r.x + 1 + ((r.w - 2) * i) / 4, r.y + 1 + ((r.h - 2) * j) / 2).find((e) => !e.closest(`[${OVERLAY_ATTR}]`));

        if (hit?.closest("input,textarea,select,button,a,iframe")) return true;
      }
    }

    return false;
  }

  /**
   * 名牌只贴着自己的圈：上下的位置要和圈横向重叠，左右的要和圈纵向重叠，否则会被读成在指旁边别的控件。
   * 先找不压文字、不压控件、不压别的圈的位置；没有就只要求不压控件；还没有就用默认位置。名牌之间始终不互相压。
   */
  function placeHandoffLabel(m: HandoffMark, labelEl: HTMLElement, frame: { x: number; y: number; w: number; h: number }): void {
    const size = labelEl.getBoundingClientRect();
    const label = { w: size.width, h: size.height };
    const originX = (parseFloat(m.el.style.left) || 0) - window.scrollX;
    const originY = (parseFloat(m.el.style.top) || 0) - window.scrollY;
    type Box = { x: number; y: number; w: number; h: number };
    const toView = (b: Box) => ({ x: originX + b.x, y: originY + b.y, w: b.w, h: b.h });
    const inView = (b: Box) => {
      const v = toView(b);

      return v.x >= 4 && v.y >= 0 && v.x + v.w <= window.innerWidth - 4 && v.y + v.h <= window.innerHeight;
    };
    const adjacent = (b: Box) => (b.x < frame.x + frame.w && b.x + b.w > frame.x) || (b.y < frame.y + frame.h && b.y + b.h > frame.y);
    const others = handoffMarks.filter((o) => o !== m && !o.done);
    const hits = (rects: DOMRect[], v: Box) => rects.some((r) => Math.min(r.right, v.x + v.w) > Math.max(r.left, v.x) && Math.min(r.bottom, v.y + v.h) > Math.max(r.top, v.y));
    const rings = others.map((o) => o.el.getBoundingClientRect());
    const labels = others.flatMap((o) => o.el.querySelector(".mark-label")?.getBoundingClientRect() ?? []);
    const best = (b: Box) => adjacent(b) && !hits(labels, toView(b)) && !coversPageContent(toView(b)) && !hits(rings, toView(b));
    let at = sketchLabelPosition(frame, label, { inView, clear: best });

    if (!best({ x: at.left, y: at.top, ...label })) at = sketchLabelPosition(frame, label, { inView, clear: (b) => adjacent(b) && !hits(labels, toView(b)) && !coversControl(toView(b)) });
    labelEl.style.left = `${at.left}px`;
    labelEl.style.top = `${at.top}px`;
  }

  /** 改名牌：撤掉旧的，按同一框线摆新的。 */
  function setHandoffLabel(m: HandoffMark, text: string | undefined): void {
    const live = liveMarks.find((l) => l.el === m.el);
    const current = m.el.querySelector<HTMLElement>(".mark-label");

    if (!live || (current?.textContent ?? undefined) === text) return;
    current?.remove();
    live.label = text;

    if (!text) return;
    const labelEl = document.createElement("div");
    labelEl.className = "mark-label sketch-label";
    labelEl.textContent = text;
    m.el.appendChild(labelEl);
    placeHandoffLabel(m, labelEl, drawSketchPaths(m.el, { x: live.pad, y: live.pad, w: live.drawn?.w ?? 0, h: live.drawn?.h ?? 0 }, live.seed ?? 1));
  }

  function syncHandoff(): void {
    for (const m of handoffMarks) {
      if (m.kind === "field") m.done = m.touched && isHandoffFilled(m.control);
      m.el.classList.toggle("faded", m.done);
    }

    const left = handoffMarks.filter((m) => m.kind === "field" && !m.done);
    const names = left.map((m) => m.name).filter(Boolean);
    const anyField = handoffMarks.some((m) => m.kind === "field");

    // 按钮的名牌先摆：按钮小、能放的位置少；栏的名牌再躲开它。
    for (const m of handoffMarks) if (m.kind === "button") setHandoffLabel(m, anyField ? "填完点这里" : "点这里");

    for (const m of handoffMarks) if (m.kind === "field") setHandoffLabel(m, m === left[0] ? (names.length ? `你来填 · ${names.join("、")}` : "你来填") : undefined);
  }

  /** 只认用户自己的输入（isTrusted）：页面脚本改值、交给用户之前就有的值都不算填好。 */
  function onHandoffInput(event: Event): void {
    if (!event.isTrusted) return;
    const path = event.composedPath();

    for (const m of handoffMarks) if (m.kind === "field" && path.includes(m.node)) m.touched = true;
    syncHandoff();
  }

  /** 只认用户真点（isTrusted）：页面脚本模拟的点击不算。 */
  function onHandoffClick(event: MouseEvent): void {
    if (!event.isTrusted) return;
    const path = event.composedPath();
    let hit = false;

    for (const m of handoffMarks) {
      if (m.kind === "button" && !m.done && path.includes(m.node)) { m.done = true; hit = true; }
    }

    if (hit) syncHandoff();
  }

  /** 圈都画好后再摆名牌，名牌才能躲开所有圈。 */
  function placeHandoffLabels(): void {
    if (!controlBar?.classList.contains("on")) { clearHandoff(); return; }
    const first = handoffMarks.find((m) => m.kind === "field") ?? handoffMarks[0];

    first?.node.scrollIntoView({ block: "nearest" });
    syncHandoff();
  }

  /** 只撤交给用户时画的圈，不碰模型画的其他标注。 */
  function clearHandoff(): void {
    if (handoffListening) {
      handoffListening = false;
      window.removeEventListener("input", onHandoffInput, true);
      window.removeEventListener("change", onHandoffInput, true);
      window.removeEventListener("click", onHandoffClick, true);
    }

    for (const m of handoffMarks) removeMark(m.el);
    handoffMarks = [];
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
  let edge: HTMLDivElement | null = null;
  /** 正在操作这一页的成员；只要仍有一位在工作，就保留选定的 C 彩边。 */
  const glowing = new Set<string>();

  // 用户一动鼠标，彩边和光标让位，停下约 1 秒再亮回来（ego 的 user-in-control 预设）。
  // 助手经调试协议发出的鼠标事件也是可信事件，但总落在光标刚飞到的点上，据此排除。
  // 不移动光标就派发的鼠标事件（受保护的悬停）先经 expect() 登记落点。
  let userIdle: ReturnType<typeof setTimeout> | undefined;
  let expected: Array<{ x: number; y: number; at: number }> = [];

  function onUserPointer(e: PointerEvent): void {
    const now = Date.now();
    expected = expected.filter(p => now - p.at < 3000);
    const near = (p?: { x: number; y: number }) => !!p && Math.abs(p.x - e.clientX) <= 6 && Math.abs(p.y - e.clientY) <= 6;

    if (expected.some(near)) return;

    for (const inst of instances.values()) {
      if (near(inst.aim) || near(inst.pos)) return;
    }

    if (!host?.classList.contains("user-active")) host?.classList.add("user-active");
    clearTimeout(userIdle);
    userIdle = setTimeout(() => host?.classList.remove("user-active"), 1100);
  }

  function watchUser(on: boolean): void {
    if (on) {
      window.addEventListener("pointermove", onUserPointer, { capture: true, passive: true });
      window.addEventListener("pointerdown", onUserPointer, { capture: true, passive: true });

      return;
    }

    window.removeEventListener("pointermove", onUserPointer, { capture: true });
    window.removeEventListener("pointerdown", onUserPointer, { capture: true });
    clearTimeout(userIdle);
    host?.classList.remove("user-active");
  }

  function renderGlow(): void {
    if (glowing.size === 0) {
      edge?.classList.remove("on");
      watchUser(false);

      return;
    }

    ensureDom();

    if (!edge?.isConnected) {
      edge = document.createElement("div");
      edge.className = "edge";
      shadow!.prepend(edge);
    }

    edge.classList.add("on");
    watchUser(true);
  }

  let crossPillSession = "";
  let remoteMembers: CrossPageMember[] = [];

  function jumpToMember(member: CrossPageMember): void {
    try {
      chrome.runtime.sendMessage({ type: "cross_page_click", sessionId: member.sessionId, tabId: member.tabId },
        (res: { ok?: boolean } | undefined) => {
          if (chrome.runtime.lastError || res?.ok !== true) hideCrossPill();
        });
    } catch { /* 自检页没有扩展运行时。 */ }
  }

  function memberButton(member: CrossPageMember & { local?: boolean; detail?: string }): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.member = member.sessionId;
    const face = document.createElement("span");
    face.className = "xface";
    face.setAttribute("aria-hidden", "true");
    const person = personFor(member.sessionId);

    if (person?.kenney) {
      mountKenney(face, chrome.runtime.getURL(`cast/${person.kenney.body}`), chrome.runtime.getURL(`cast/${person.kenney.face}`), 22);
    } else if (person) {
      mountGrok(face, person, 22, { animate: false });
    } else {
      const fallback = svgEl("svg", { viewBox: "0 0 128 128", "aria-hidden": "true" });
      const group = svgEl("g", { fill: "none", stroke: "currentColor", "stroke-width": 26, "stroke-linecap": "round" });
      group.append(svgEl("path", { d: "M53 22L32 79" }), svgEl("path", { d: "M94 41L73 98" }));
      fallback.appendChild(group);
      face.replaceChildren(fallback);
    }

    const name = document.createElement("span");
    name.className = "xmain";
    name.textContent = displayNameFor(member.sessionId);
    const title = document.createElement("span");
    title.className = "xsub";
    title.textContent = member.local ? member.title : `在 ${member.title}`;
    const arrow = document.createElement("span");
    arrow.className = "xarrow";
    arrow.textContent = member.local ? "⌄" : "↗";
    arrow.setAttribute("aria-hidden", "true");
    const state = member.state === "reading" ? "正在读取" : "等待响应";
    button.title = `${name.textContent} · ${state} · ${member.title}`;
    button.setAttribute("aria-label", member.local ? `${name.textContent} · ${member.title}，查看详情` : `${button.title}，切换到工作页面`);
    button.append(face, name, title, arrow);

    if (member.local) {
      button.title = member.detail || member.title;
      button.setAttribute("aria-expanded", "false");
      button.onclick = () => {
        let detail = button.nextElementSibling as HTMLElement | null;

        if (!detail?.classList.contains("xdetail")) {
          detail = document.createElement("div"); detail.className = "xdetail xlist";
          detail.textContent = member.detail || member.title; detail.hidden = true; button.after(detail);
        }

        detail.hidden = !detail.hidden; detail.inert = detail.hidden; button.setAttribute("aria-expanded", String(!detail.hidden));
      };
    } else button.onclick = () => jumpToMember(member);

    return button;
  }

  function showCrossPill(view: CrossPageView): void {
    remoteMembers = view.members?.length ? view.members : [{ sessionId: view.sessionId ?? "main", title: view.title?.trim() || "另一个页面", tabId: view.tabId, state: view.state }];
    crossPillSession = view.sessionId ?? remoteMembers[0]!.sessionId;

    for (const member of remoteMembers) {
      const inst = instances.get(member.sessionId);

      if (inst && !inst.hold) hide(inst);
    }

    renderAmbient();
  }

  function renderAmbient(): void {
    const members: Array<CrossPageMember & { local?: boolean; detail?: string }> = [...remoteMembers];

    for (const [id, inst] of instances) {
      if (inst.hold || remoteMembers.some(m => m.sessionId === id)) continue;

      if (inst.action) {
        const a = inst.action;
        const verb = {click:"点", fill:"填", hover:"看"}[a.kind];
        const text = a.phase === "active" ? `正在${verb}` : a.phase === "unknown" ? "结果未知" : a.phase === "failed" ? "没做成" : `${verb}完了`;
        members.push({sessionId:id, title:text, local:true, detail:a.name ? `${text} · ${a.name}` : text});
      } else if (inst.status) members.push({sessionId:id, title:inst.status.text, local:true, detail:inst.status.detail || inst.status.sub || inst.status.text});
    }

    if (!members.length) { crossPill?.classList.remove("on");

 return; }

    ensureDom();

    if (!crossPill?.isConnected) {
      crossPill = document.createElement("div");
      crossPill.className = "xpage";
      crossPill.addEventListener("click", ev => ev.stopPropagation());
      shadow!.appendChild(crossPill);
    }

    const previousText = new Map(Array.from(crossPill.querySelectorAll<HTMLButtonElement>("button[data-member]")).map(button => [button.dataset.member, button.querySelector(".xsub")?.textContent]));
    const wasOpen = crossPill.querySelector("button")?.getAttribute("aria-expanded") === "true";
    const hadFocus = crossPill.contains(shadow?.activeElement ?? null);
    crossPill.replaceChildren();

    // 只有本页这一位助手：右上角只管「停下」，正在做什么由光标旁那句话说，不在这里重复。
    if (members.length === 1 && members[0]!.local) {
      crossPill.onkeydown = null;
      crossPill.append(stopBar());
      crossPill.classList.add("on");

      return;
    }

    const trigger = memberButton(members[0]!);

    if (members.length > 1) {
      trigger.querySelector(".xmain")!.textContent = `${members.length} 位助手`;
      trigger.querySelector(".xsub")!.textContent = "查看工作状态";
      trigger.title = "查看助手与工作页面";
      trigger.setAttribute("aria-label", `${members.length} 位助手，展开工作状态`);
      trigger.setAttribute("aria-expanded", "false");
      const list = document.createElement("div");
      list.className = "xlist";
      list.hidden = !wasOpen;

      if (wasOpen) list.dataset.restored = "true";
      list.inert = list.hidden;
      trigger.setAttribute("aria-expanded", String(wasOpen));
      list.append(...members.map(memberButton));
      trigger.onclick = () => { delete list.dataset.restored; list.hidden = !list.hidden; list.inert = list.hidden; trigger.setAttribute("aria-expanded", String(!list.hidden)); };

      crossPill.onkeydown = ev => { if (ev.key === "Escape") { list.hidden = true; list.inert = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); ev.stopPropagation(); } };

      crossPill.append(trigger, list);
    } else {
      crossPill.onkeydown = null;
      crossPill.append(trigger);
    }

    crossPill.classList.add("on");

    if (!reducedMotion.matches) {
      for (const button of crossPill.querySelectorAll<HTMLButtonElement>("button[data-member]")) {
        const text = button.querySelector<HTMLElement>(".xsub");

        if (text && previousText.has(button.dataset.member) && previousText.get(button.dataset.member) !== text.textContent) {
          text.animate([{opacity:.4, transform:"translateY(2px)"}, {opacity:1, transform:"translateY(0)"}], {duration:150, easing:"ease-out"});
        }
      }
    }

    if (hadFocus) trigger.focus();
  }

  function stopBar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "xbar";
    const orb = document.createElement("span");
    orb.className = "orb-dot";
    orb.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "xmain";
    name.textContent = "By Your Side";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "xstop";
    stop.textContent = "中止";
    stop.onclick = (ev) => {
      ev.stopPropagation();
      stop.disabled = true;
      stop.textContent = "正在中止";

      try {
        chrome.runtime.sendMessage({ type: "page_stop_click" }, (res: { ok?: boolean } | undefined) => {
          if (chrome.runtime.lastError || res?.ok !== true) { stop.disabled = false; stop.textContent = "中止"; }
        });
      } catch { /* 自检页没有扩展运行时。 */ }
    };

    bar.append(orb, name, stop);

    return bar;
  }

  function hideCrossPill(): void {
    remoteMembers = [];
    renderAmbient();
  }

  // ── 执行反馈胶囊：宿主事实短语（切好了 / 已填入 / 结果未知…）────────────
  // 成功一次轻微回弹后收起；待处理保留可找到的文字入口；同一结果重绘不回弹。

  let feedbackPill: HTMLDivElement | null = null;
  let feedbackPillState: FeedbackPillState | null = null;
  let feedbackTimer: number | undefined;

  /** 跨页胶囊与反馈胶囊共用右上角；同时出现时反馈在上，跨页入口下移。 */
  function positionCrossPill(): void {
    if (crossPill) crossPill.style.top = feedbackPillState ? "64px" : "";
  }

  function renderFeedbackPill(): void {
    if (!feedbackPillState) {
      feedbackPill?.classList.remove("on");
      positionCrossPill();

      return;
    }

    ensureDom();

    if (!feedbackPill?.isConnected) {
      feedbackPill = document.createElement("div");
      feedbackPill.className = "xpage xfeedback";
      feedbackPill.addEventListener("click", ev => { ev.stopPropagation(); hideFeedbackPill(); });
      shadow!.appendChild(feedbackPill);
    }

    const button = document.createElement("button");
    button.type = "button";
    const main = document.createElement("span");
    main.className = "xmain";
    main.textContent = feedbackPillState.text;
    button.append(main);

    if (feedbackPillState.kind !== "success") {
      const sub = document.createElement("span");
      sub.className = "xsub";
      sub.textContent = "详情在侧栏";
      button.append(sub);
    }

    button.title = feedbackPillState.detail || feedbackPillState.text;
    button.setAttribute("aria-label", feedbackPillState.text);
    feedbackPill.replaceChildren(button);
    feedbackPill.classList.add("on");
    positionCrossPill();
  }

  function showFeedbackPill(view?: FeedbackPillView): void {
    if (!view?.text) return;
    const next: FeedbackPillView = { id: view.id || `f-${Date.now()}`, text: view.text, kind: view.kind ?? "success" };

    if (view.detail) next.detail = view.detail;
    const { state, bounce } = beginFeedbackPill(feedbackPillState, next, Date.now());
    // 减少动态偏好：不回弹，但仍展示；成功仍算一次独立反馈（bounces 记 0）。
    const played = bounce && !reducedMotion.matches;
    feedbackPillState = played || !bounce ? state : { ...state, bounces: 0 };
    renderFeedbackPill();

    if (played) {
      feedbackPill?.querySelector("button")?.animate(
        [{ transform: "scale(.94)" }, { transform: "scale(1.035)", offset: .55 }, { transform: "scale(1)" }],
        { duration: 340, easing: "cubic-bezier(.22,1,.36,1)" },
      );
    }

    if (feedbackTimer !== undefined) clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => hideFeedbackPill(), feedbackLifetimeMs(feedbackPillState.kind));
  }

  function hideFeedbackPill(): void {
    if (feedbackTimer !== undefined) {
      clearTimeout(feedbackTimer);
      feedbackTimer = undefined;
    }

    feedbackPillState = null;
    renderFeedbackPill();
  }

  function teardown(event: PageTransitionEvent): void {
    if (guide) endGuide(guide);
    clearHandoff();

    if (actionFrame !== undefined) cancelAnimationFrame(actionFrame);
    actionFrame = undefined;

    for (const inst of instances.values()) {
      stopReplayInst(inst);
      cancelFly(inst);
      clearTimeout(inst.parkTimer);
      clearTimeout(inst.pressTimer);
      clearStatusTimers(inst);
      // pagehide may freeze the page in BFCache; an old fade callback must
      // never reach a newly restored cursor or a different action.
      inst.labelAnimation?.cancel();
      inst.labelAnimation = undefined;
    }

    remoteMembers = [];
    instances.clear();
    liveMarks.length = 0;

    if (feedbackTimer !== undefined) clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    feedbackPillState = null;
    feedbackPill = null;
    // Pagehide may freeze this Document in BFCache. Do not revive finished
    // task lighting when pageshow later reuses the same content-script world.
    glowing.clear();
    watchUser(false);
    edge = null;
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
    // BFCache restoration does not rerun the content script. Keep only its
    // API bindings, without preserving any old DOM, status, timer or glow.
    if (!event.persisted) {
      ns.cursor = undefined;
      ns.cursorHidden = undefined;
      ns.cursorState = undefined;
      ns.markLayout = undefined;
      ns.markLayerCount = undefined;
      ns.marksState = undefined;
      ns.handoffState = undefined;
      ns.holdState = undefined;
      ns.holdActionLabels = undefined;
      ns.clickHoldAction = undefined;
      ns.controlBanner = undefined;
      ns.clickHandback = undefined;
      ns.cursorStatus = undefined;
      ns.crossPageState = undefined;
      ns.feedbackState = undefined;
      ns.clickCrossPage = undefined;
      ns.setMarkConfig = undefined;
      ns.getMarkConfig = undefined;
      ns.markDetails = undefined;
    }
  }

  window.addEventListener("pagehide", teardown);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !ns.cursor) return;
    // A saved Document may be shown more than once. Rebuild the primary
    // idle cursor once, without starting an action or re-enabling page glow.
    if (!host?.isConnected || !instances.has(DEFAULT_ID)) ns.cursor.park?.();
  });

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
        renderAmbient();
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
        renderAmbient();
        schedulePark(inst, 2000);
      },
      arrive(x, y): void {
        const inst = instances.get(id);

        if (!inst?.visible) return;
        cancelFly(inst);

        if (inst.action) inst.action.arrived = true;
        setPos(inst, { x, y });
      },
      expect(x: number, y: number): void {
        expected.push({ x, y, at: Date.now() });
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

        if (inst) { clearStatusInst(inst);

 if (inst.action && inst.action.phase !== "active") clearAction(inst); }
      },

      showCrossPage(view?: CrossPageView): void {
        showCrossPill(view ?? {});
      },

      hideCrossPage(): void {
        hideCrossPill();
      },

      setGlow(on: boolean): void {
        if (on) glowing.add(id);
        else glowing.delete(id);
        renderGlow();
      },

      showFeedback(view?: FeedbackPillView): void {
        showFeedbackPill(view);
      },

      hideFeedback(): void {
        hideFeedbackPill();
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
        observedNode?: Node | Range,
      ): void {
        const inst = getInstance(id);
        const mark = spawnMark(inst, rect, label, target, options, observedNode);
        // 就地确认：键不在框外，光标飞到目标拿住，双键长在名牌上
        const parsed = resolveImplicitMarkActions(label, actions);

        if (parsed) {
          holdInst(inst, Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2), parsed, target, mark);
        }
      },

      guide(rect: SideAgentRect, say: string, target: string, portName: string, options?: MarkOptions, observedNode?: Node): { name: string } {
        const node = observedNode ?? resolveAnchor(rect, target);

        if (!node) throw new Error(`未找到目标元素：${target}`);

        return startGuide(getInstance(id), node, say, target, portName, options);
      },

      handoffMark(rect: SideAgentRect, target: string, options?: MarkOptions, observedNode?: Node): void {
        addHandoffMark(getInstance(id), rect, target, options, observedNode);
      },

      handoffLabels(): void {
        placeHandoffLabels();
      },

      clearMarks(): void {
        clearHandoff();
        liveMarks.length = 0;
        marksLayer?.replaceChildren();
      },

      for(instanceId: string): SideAgentCursor {
        return api(instanceId);
      },
    };
  }

  ns.cursor = api(DEFAULT_ID);
  // 每个普通网页自动显示主光标的静态停靠态；不启动动画帧。
  // 工作开始时复用这个实例，扩展重复注入不会再创建第二个光标。
  ns.cursor.park?.();
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
    crossPill.querySelector("button")?.click();

    return true;
  };

  ns.feedbackState = () => feedbackPillState ? {
    id: feedbackPillState.id,
    text: feedbackPillState.text,
    kind: feedbackPillState.kind,
    bounces: feedbackPillState.bounces,
    visible: Boolean(feedbackPill?.classList.contains("on")),
  } : null;
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
      guide: guide?.inst === inst ? { label: guide.mark?.querySelector(".mark-label")?.textContent ?? "", misses: guide.misses, parkedAtTarget: Boolean(inst.hold?.corner), checking: Boolean(guide.watch && !guide.watch.settled) } : null,
    };
  };

  ns.markLayout = () =>
    liveMarks.map((m) => {
      const viewRect = (e: Element | null) => {
        const r = e?.getBoundingClientRect();

        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      };

      return {
        x: parseFloat(m.el.style.left) || 0,
        y: parseFloat(m.el.style.top) || 0,
        width: parseFloat(m.el.style.width) || 0,
        height: parseFloat(m.el.style.height) || 0,
        stroke: viewRect(m.el.querySelector(".sketch-frame-path")),
        label: viewRect(m.el.querySelector(".mark-label")),
      };
    });
  /** overlay 自检：标注层真实子节点数（不等于 liveMarks 记账） */
  ns.markLayerCount = () => marksLayer?.childElementCount ?? 0;
  /** 核验读数：每个标注此刻圈住哪个元素、是否显示；只读，不改标注。 */
  ns.marksState = () =>
    liveMarks.map((m) => {
      const node = m.observedNode instanceof Range ? m.observedNode.commonAncestorContainer : m.observedNode;
      const anchor = node ? (node instanceof Element ? node : node.parentElement) : liveAnchor(m);

      return {
        label: m.label ?? "",
        element: anchor?.isConnected ? { tag: anchor.tagName.toLowerCase(), name: actionName(anchor) } : null,
        shown: m.el.isConnected && m.el.style.visibility !== "hidden",
      };
    });
  /** 交给用户时画的圈的读数：页面脚本读不到；只读，不改圈。 */
  ns.handoffState = () =>
    handoffMarks.map((m) => {
      const r = m.el.querySelector(".mark-label")?.getBoundingClientRect();

      return {
        kind: m.kind,
        name: m.name,
        label: m.el.querySelector(".mark-label")?.textContent ?? "",
        labelRect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        faded: m.el.classList.contains("faded"),
        shown: m.el.isConnected,
      };
    });
  ns.setMarkConfig = (opts: MarkOptions) => {
    defaultMarkOptions = { ...defaultMarkOptions, ...opts };
  };

  ns.getMarkConfig = () => ({ ...defaultMarkOptions });
  ns.markDetails = () =>
    liveMarks.map((m) => {
      const svg = m.el.querySelector("svg.sketch-svg");
      const boilPaths = svg ? [...svg.querySelectorAll(".boil-path")] : [];
      const framePath = svg?.querySelector(".sketch-frame-path");
      const labelEl = m.el.querySelector(".sketch-label") ?? m.el.querySelector(".mark-label");

      return {
        className: m.el.className,
        hasSvg: Boolean(svg),
        isGrow: m.el.classList.contains("grow"),
        isBoil: m.el.classList.contains("boil"),
        isSketch: m.el.classList.contains("sketch"),
        hasFrame: Boolean(framePath),
        boilFrameCount: boilPaths.length,
        labelText: labelEl?.textContent ?? "",
      };
    });
})();
