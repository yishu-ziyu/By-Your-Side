import { OVERLAY_ATTR, OVERLAY_KIND_EDGE_TAB } from "../shared/overlay.js";

/**
 * 页面右边缘的状态胶囊：侧栏开着时从侧栏边长出来，关着时贴在窗口右边。
 * 只管画：显示什么由 cursor.ts 汇总后交给 render；同一时刻只有一个主胶囊，别页的助手挂在下方小圆泡里。
 * 形状和内容用弹簧积分驱动（不是按时间算的闭式曲线），新状态随时打断，从当前形状接着变。
 */

export type EdgeTabTone = "work" | "wait" | "ok" | "unk" | "err" | "hand" | "away";

export type EdgeTabEnd = "stop" | "arrow" | { label: string; enabled: boolean };

export interface EdgeTabView {
  tone: EdgeTabTone;
  /** 左段，默认灰（动词）；lead 时加粗（「现在归你」在前）。 */
  a: string;
  /** 右段，默认正文色（对象）；lead 时变灰。 */
  b: string;
  lead?: boolean;
  /** 「已」和对象之间不留空。 */
  tight?: boolean;
  end?: EdgeTabEnd;
  hint?: string;
}

export interface EdgeTabOther {
  id: string;
  name: string;
  title: string;
  local: boolean;
  detail?: string;
}

export interface EdgeTabHandlers {
  capsule(): void;
  stop(): Promise<boolean>;
  action(): void;
  other(other: EdgeTabOther): void;
}

/** 胶囊上边离视口顶部的距离。 */
const TOP = 64;
const H = 40;
const MID = TOP + H / 2;
const CLOSED = { w: 10, h: 30 };
const PADL = 14;
const GAP = 8;
const WGAP = 4;
const ICON = 18;
const STOP = 26;
const BUBBLE_H = 30;
const BUBBLE_GAP = 10;
/** 小圆泡点开后长成的面板：宽度、圆角（和小圆泡同一个半径，长大时形状连续）、列表最高多少。 */
const PANEL_W = 280;
const BUBBLE_R = BUBBLE_H / 2;
const ROWS_MAX_H = 260;
/** SVG 画布比胶囊大：上下留给凹弧和阴影，宽度留给最长的一句。 */
const CANVAS_W = 520;
const CANVAS_H = 560;

/** 伸出、换内容、收回各一组弹簧（response 秒，damping）。 */
const OPEN = [0.42, 0.82] as const;
const MORPH = [0.36, 0.86] as const;
const CLOSE = [0.32, 0.94] as const;
/** 进行中的字上扫过一道光的周期。 */
const SHIMMER_S = 1.6;
/** 收回前先让内容淡出。 */
const CONTENT_OUT_MS = 120;
const CONTENT_IN_MS = 240;
const CONTENT_IN_DELAY_MS = 60;
const FADE_MS = 200;

const FONT = `-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Helvetica Neue",sans-serif`;

const STYLE = `
:host{all:initial}
.root{--panel:oklch(0.980 0.0055 88);--ink:oklch(22% 0.012 285);--ink2:oklch(54% 0.02 285);--btn:oklch(22% 0.02 285 / .07);--btnh:oklch(22% 0.02 285 / .13);
  --accent:oklch(58% 0.2 285);--ok:oklch(66% 0.17 150);--warn:oklch(72% 0.15 70);--err:oklch(60% 0.2 25);--objw:600;--hi:color-mix(in oklch,var(--ink2) 55%,var(--panel));
  position:fixed;top:0;right:0;width:${CANVAS_W}px;height:${CANVAS_H}px;pointer-events:none;font:13px/1 ${FONT};letter-spacing:-.01em;color:var(--ink);
  -webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.root{--panel:#211f1b;--ink:rgb(250,242,230);--ink2:oklch(70% 0.014 285);--btn:rgba(255,255,255,.09);--btnh:rgba(255,255,255,.17);--accent:oklch(74% 0.14 285);--objw:500;--hi:color-mix(in oklch,var(--ink2) 55%,rgb(255,247,234))}}
.root[hidden]{display:none}
.canvas{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.clip{position:absolute;overflow:hidden;pointer-events:auto;cursor:pointer;outline:none;border-radius:20px 0 0 20px}
.clip:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
.el{position:absolute;top:0;height:100%;display:flex;align-items:center;white-space:nowrap;will-change:transform,opacity,filter}
.t{overflow:hidden;text-overflow:ellipsis;line-height:1.25}
.a .t{max-width:150px}.b .t{max-width:210px}
.dim{color:var(--ink2);font-weight:500}.strong{color:var(--ink);font-weight:var(--objw)}
.ic{width:${ICON}px;height:${ICON}px;display:grid;place-items:center}
/* 进行中不放图标：动词上一道光从右往左扫过。背景比字宽三倍，挪背景位置就是挪那道光。
   高光只到动词灰和底色的中间：亮到接近底色时，光扫过的那个字会看不见。 */
.shim{background:linear-gradient(90deg,var(--ink2) 0%,var(--ink2) 41%,var(--hi) 50%,var(--ink2) 59%,var(--ink2) 100%);background-size:300% 100%;
  -webkit-background-clip:text;background-clip:text;color:transparent;animation:shim ${SHIMMER_S}s linear infinite}
@keyframes shim{from{background-position:0% 0}to{background-position:100% 0}}
.rg{stroke-dasharray:47.1;stroke-dashoffset:47.1;animation:draw .35s cubic-bezier(.45,0,.55,1) .2s forwards}
.ck{stroke-dasharray:10;stroke-dashoffset:10;animation:draw .22s cubic-bezier(.45,0,.55,1) .45s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
button{all:unset;box-sizing:border-box;cursor:pointer;pointer-events:auto;font:inherit}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.stop{width:${STOP}px;height:${STOP}px;border-radius:50%;background:var(--btn);display:grid;place-items:center;transition:background-color .12s ease,transform .08s ease}
.stop i{width:8px;height:8px;border-radius:2px;background:var(--ink)}
.stop:hover{background:var(--btnh)}
.stop:active{transform:scale(.94)}
.stop:disabled{opacity:.5;cursor:default}
.act{height:${STOP}px;border-radius:13px;padding:0 11px;display:grid;place-items:center;font-size:12.5px;font-weight:600;background:var(--warn);color:#fff;transition:filter .12s ease,transform .08s ease}
.act:hover{filter:brightness(.94)}
.act:active{transform:scale(.94)}
.act:disabled{opacity:.55;cursor:default}
.arrow{color:var(--ink2);font-size:13px;width:14px;text-align:center}
.av{width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,#ff8a65,#e1251b);color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center;flex:none;overflow:hidden}
.bub{position:absolute;overflow:hidden;pointer-events:auto;border-radius:${BUBBLE_R}px 0 0 ${BUBBLE_R}px}
.bhead{display:flex;align-items:center;gap:5px;padding-left:8px;height:${BUBBLE_H}px;cursor:pointer;outline:none}
.bhead .n{font-size:12px;font-weight:600;color:var(--ink);flex:none}
.bhead:focus-visible{box-shadow:inset 0 0 0 2px var(--accent);border-radius:${BUBBLE_R}px 0 0 ${BUBBLE_R}px}
.rows{width:${PANEL_W - 1}px;max-height:${ROWS_MAX_H}px;overflow-y:auto;box-sizing:border-box;padding:0 5px 5px}
.row{display:flex;align-items:center;gap:8px;width:100%;padding:8px;border-radius:9px;transition:background-color .12s ease}
.row:hover{background:var(--btn)}
.row .nm{font-weight:var(--objw);flex:none}
.row .ti{color:var(--ink2);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;line-height:1.25}
.row .go{margin-left:auto;color:var(--ink2);flex:none}
.detail{font-size:12px;line-height:1.5;color:var(--ink2);padding:2px 8px 8px 34px;overflow-wrap:anywhere}
.detail[hidden]{display:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media (prefers-reduced-motion:reduce){.shim{animation:none;background:none;color:var(--ink2)}.rg,.ck{animation-duration:.01s;animation-delay:0s}}
`;

const SVG_NS = "http://www.w3.org/2000/svg";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 欠阻尼弹簧，按帧积分：目标中途改了，从当前位置和速度接着走。 */
class Spring {
  x: number;
  v = 0;
  to: number;
  private k = 0;
  private c = 0;

  constructor(x: number) { this.x = this.to = x; }

  aim(to: number, [response, damping]: readonly [number, number]): void {
    const w = (2 * Math.PI) / response;
    this.to = to;
    this.k = w * w;
    this.c = 2 * damping * w;
  }

  snap(to: number): void { this.x = this.to = to; this.v = 0; }

  step(dt: number): void {
    const n = 4;
    const h = dt / n;

    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - this.to) - this.c * this.v) * h;
      this.x += this.v * h;
    }

    if (Math.abs(this.x - this.to) < 0.02 && Math.abs(this.v) < 0.02) this.snap(this.to);
  }

  get still(): boolean { return this.x === this.to && this.v === 0; }
}

type Slot = "icon" | "a" | "b" | "end";

interface Item { slot: Slot; key: string; el: HTMLElement; x: Spring; width: number; leaving?: boolean }

function shapePath(X: number, w: number, h: number, mid: number, c: number, rMax = Infinity): string {
  const C = c * clamp01(w / 48);
  const R = Math.min(h / 2, w, rMax);
  const top = mid - h / 2;
  const b = top + h;
  const L = X - w;

  return `M${X + 1},${top - C} L${X},${top - C} Q${X},${top} ${X - C},${top} L${L + R},${top} Q${L},${top} ${L},${top + R} L${L},${b - R} Q${L},${b} ${L + R},${b} L${X - C},${b} Q${X},${b} ${X},${b + C} L${X + 1},${b + C} Z`;
}

function hairPath(X: number, w: number, h: number, mid: number, rMax = Infinity): string {
  const R = Math.min(h / 2, w, rMax);
  const top = mid - h / 2;
  const b = top + h;
  const L = X - w;

  return `M${X},${top} L${L + R},${top} Q${L},${top} ${L},${top + R} L${L},${b - R} Q${L},${b} ${L + R},${b} L${X},${b}`;
}

/** 进行中（在干活、在等、在别页）没有图标，只有扫光的字；有了结果才出图标。 */
const IN_PROGRESS = new Set<EdgeTabTone>(["work", "wait", "away"]);

function iconFor(tone: EdgeTabTone): string {
  switch (tone) {
    case "ok": return `<svg class="ic" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--btn)" stroke-width="2"/><circle class="rg" cx="9" cy="9" r="7.5" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" transform="rotate(-90 9 9)"/><path class="ck" d="M5.6 9.2 L8 11.4 L12.4 6.8" fill="none" stroke="var(--ok)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "unk": return `<svg class="ic" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--warn)" stroke-width="2"/><text x="9" y="13" text-anchor="middle" font-size="11" font-weight="700" fill="var(--warn)" font-family="-apple-system,sans-serif">?</text></svg>`;
    case "err": return `<svg class="ic" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="var(--err)"/><path d="M9 4.8 V10" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="13" r="1.2" fill="#fff"/></svg>`;
    default: return `<svg class="ic" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="var(--warn)"/><path d="M9 4.5 V9.5 M6.5 7.5 L9 10 L11.5 7.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 9 9)"/></svg>`;
  }
}

/**
 * 头像用那一页标题的首字，不用站点图标：图标地址放进这一页，这一页的网站就能看到用户还开着哪一页。
 */
function avatar(other: EdgeTabOther): HTMLElement {
  const av = document.createElement("span");
  av.className = "av";
  av.setAttribute("aria-hidden", "true");
  av.textContent = Array.from(other.title.trim() || other.name)[0] ?? "·";

  return av;
}

export interface EdgeTabState {
  shown: boolean;
  tone: EdgeTabTone | null;
  a: string;
  b: string;
  end: string | null;
  endEnabled: boolean;
  /** 弹簧停稳后的目标尺寸；rect 是这一帧实际画出来的位置。 */
  width: number;
  rect: { x: number; y: number; width: number; height: number } | null;
  panel: string;
  /** rect 是小圆泡顶上可点的那一行；panel 是整块（点开后长成的面板）。 */
  bubble: { count: number; letter: string; rect: { x: number; y: number; width: number; height: number }; panel: { x: number; y: number; width: number; height: number } } | null;
  list: { open: boolean; rows: Array<{ name: string; title: string; local: boolean; rect: { x: number; y: number; width: number; height: number } }> };
  /** 停止键或「继续」此刻的位置，验收用真鼠标点它。 */
  button: { x: number; y: number; width: number; height: number } | null;
  /** 胶囊上有没有图标；动词上的扫光此刻在不在动。 */
  icon: boolean;
  shimmer: boolean;
}

export function createEdgeTab(handlers: EdgeTabHandlers) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const host = document.createElement("div");
  host.setAttribute(OVERLAY_ATTR, OVERLAY_KIND_EDGE_TAB);
  host.style.cssText = "all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483646;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>${STYLE}</style><div class="root" hidden>
<svg class="canvas" width="${CANVAS_W}" height="${CANVAS_H}"><defs>
<filter id="sh" x="-60%" y="-100%" width="220%" height="300%"><feDropShadow class="s" dx="0" dy="1" stdDeviation=".8" flood-opacity="0"/><feDropShadow class="s" dx="-1" dy="4" stdDeviation="4" flood-opacity="0"/><feDropShadow class="s" dx="-2" dy="12" stdDeviation="12" flood-opacity="0"/></filter>
<linearGradient id="hair" x1="0" y1="0" x2="1" y2="1"><stop class="h" offset="0"/><stop class="h" offset=".5"/><stop class="h" offset="1"/></linearGradient>
</defs><path class="shape" filter="url(#sh)" style="fill:var(--panel)"/><path class="hl" fill="none" stroke="url(#hair)" stroke-width=".75"/>
<path class="shape" filter="url(#sh)" style="fill:var(--panel)"/><path class="hl" fill="none" stroke="url(#hair)" stroke-width=".75"/></svg>
<div class="clip" role="button" tabindex="0"></div><div class="bub"><div class="bhead" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false"></div><div class="rows"></div></div><span class="sr" role="status" aria-live="polite"></span></div>`;
  const root = shadow.querySelector<HTMLDivElement>(".root")!;
  const [mainShape, bubShape] = Array.from(shadow.querySelectorAll<SVGPathElement>("path.shape"));
  const [mainHair, bubHair] = Array.from(shadow.querySelectorAll<SVGPathElement>("path.hl"));
  const shadows = Array.from(shadow.querySelectorAll<SVGElement>(".s"));
  const hairStops = Array.from(shadow.querySelectorAll<SVGElement>(".h"));
  const clip = shadow.querySelector<HTMLDivElement>(".clip")!;
  const bub = shadow.querySelector<HTMLDivElement>("div.bub")!;
  const bhead = shadow.querySelector<HTMLDivElement>(".bhead")!;
  const list = shadow.querySelector<HTMLDivElement>(".rows")!;
  const live = shadow.querySelector<HTMLSpanElement>(".sr")!;
  const X = CANVAS_W;

  const W = new Spring(CLOSED.w);
  const Hs = new Spring(CLOSED.h);
  const BW = new Spring(0);
  const BH = new Spring(BUBBLE_H);
  let items: Item[] = [];
  let view: EdgeTabView | null = null;
  let others: EdgeTabOther[] = [];
  let open = false;
  let closeAt = 0;
  /** 整体可见度：减少动态效果时靠它淡入淡出，否则随形状宽度算出来。 */
  let fade = 0;
  let raf: number | undefined;
  let last = 0;
  let listOpen = false;
  let stopPending = false;
  let bubbleKey = "";
  let listRows = "";

  const clickedButton = (ev: Event) => ev.composedPath().some(n => n instanceof HTMLButtonElement);

  clip.addEventListener("click", ev => { ev.stopPropagation(); if (!clickedButton(ev)) handlers.capsule(); });
  clip.addEventListener("keydown", ev => {
    if (ev.target !== clip || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    handlers.capsule();
  });
  const toggleList = () => setList(!listOpen);
  bub.addEventListener("click", ev => ev.stopPropagation());
  bhead.addEventListener("click", ev => { ev.stopPropagation(); toggleList(); });
  bhead.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleList(); }
  });
  root.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && listOpen) { setList(false); bhead.focus(); ev.stopPropagation(); }
  });

  /** 列表不是另起一张卡：小圆泡原地向下、向左长成贴边面板，收起时按同一套弹簧缩回小圆泡。 */
  function setList(on: boolean): void {
    const next = on && others.length > 0;
    bhead.setAttribute("aria-expanded", String(next));
    list.inert = !next;

    if (next === listOpen) return;
    listOpen = next;

    if (listOpen) renderList();

    if (reduced.matches) list.animate([{ opacity: listOpen ? 0 : 1 }, { opacity: listOpen ? 1 : 0 }], { duration: FADE_MS, fill: "forwards" });
    paintBubble();
    kick();
  }

  function renderList(): void {
    listRows = others.map(o => `${o.id}|${o.title}|${o.detail ?? ""}`).join("\n");
    list.replaceChildren(...others.flatMap(o => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.dataset.member = o.id;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = o.name;
      const ti = document.createElement("span");
      ti.className = "ti";
      ti.textContent = o.local ? o.title : `在 ${o.title}`;
      const go = document.createElement("span");
      go.className = "go";
      go.setAttribute("aria-hidden", "true");
      go.textContent = o.local ? "⌄" : "↗";
      row.append(avatar(o), nm, ti, go);
      row.title = o.local ? o.detail || o.title : `${o.name} · ${o.title}`;
      row.setAttribute("aria-label", o.local ? `${o.name} · ${o.title}，查看详情` : `${o.name} 在 ${o.title}，切换到那一页`);

      if (!o.local) {
        row.onclick = ev => { ev.stopPropagation(); handlers.other(o); };

        return [row];
      }

      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = o.detail || o.title;
      detail.hidden = true;
      row.setAttribute("aria-expanded", "false");
      row.onclick = ev => {
        ev.stopPropagation();
        detail.hidden = !detail.hidden;
        row.setAttribute("aria-expanded", String(!detail.hidden));
      };

      return [row, detail];
    }));
  }

  let attached = false;

  /**
   * 只挂一次。扩展重载后新脚本会清掉旧胶囊；旧脚本的计时器还可能再画一次，被清掉后不再挂回，免得留下一个点不动的死胶囊。
   */
  function attach(): boolean {
    if (host.isConnected) return true;

    if (attached) return false;
    attached = true;
    (document.documentElement ?? document.body).append(host);

    return true;
  }

  function makeItem(slot: Slot, key: string, v: EdgeTabView): Item {
    const el = document.createElement("div");
    el.className = `el ${slot}`;

    if (slot === "icon") el.innerHTML = iconFor(v.tone);
    else if (slot === "a" || slot === "b") {
      const t = document.createElement("span");
      const strong = slot === "a" ? v.lead : !v.lead;
      t.className = `t ${strong ? "strong" : "dim"}${slot === "a" && IN_PROGRESS.has(v.tone) ? " shim" : ""}`;
      t.textContent = slot === "a" ? v.a : v.b;
      el.append(t);
    } else if (v.end === "stop") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stop";
      b.setAttribute("aria-label", "中止");
      b.title = "中止";
      b.append(document.createElement("i"));
      b.disabled = stopPending;
      b.onclick = ev => {
        ev.stopPropagation();

        if (stopPending) return;
        stopPending = true;
        b.disabled = true;
        void handlers.stop().then(ok => { if (!ok) { stopPending = false; b.disabled = false; } });
      };
      el.append(b);
    } else if (v.end === "arrow") {
      const s = document.createElement("span");
      s.className = "arrow";
      s.setAttribute("aria-hidden", "true");
      s.textContent = "↗";
      el.append(s);
    } else if (v.end) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "act";
      b.textContent = v.end.label;
      b.disabled = !v.end.enabled;
      b.onclick = ev => { ev.stopPropagation(); handlers.action(); };
      el.append(b);
    }

    clip.append(el);

    return { slot, key, el, x: new Spring(0), width: el.offsetWidth };
  }

  function slotKey(slot: Slot, v: EdgeTabView): string | null {
    if (slot === "icon") return IN_PROGRESS.has(v.tone) ? null : v.tone;
    if (slot === "a") return v.a ? `${v.lead ? 1 : 0}${IN_PROGRESS.has(v.tone) ? 1 : 0}${v.a}` : null;
    if (slot === "b") return v.b ? `${v.lead ? 1 : 0}${v.b}` : null;
    if (!v.end) return null;

    return typeof v.end === "string" ? v.end : `act:${v.end.label}:${v.end.enabled}`;
  }

  function fadeIn(el: HTMLElement): void {
    if (reduced.matches) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: CONTENT_IN_MS, delay: CONTENT_IN_DELAY_MS, fill: "backwards" });

      return;
    }

    el.animate(
      [{ opacity: 0, filter: "blur(3px)", transform: "translateY(4px)" }, { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" }],
      { duration: CONTENT_IN_MS, delay: CONTENT_IN_DELAY_MS, easing: "cubic-bezier(.33,1,.68,1)", fill: "backwards" },
    );
  }

  function fadeOut(item: Item): void {
    item.leaving = true;
    item.el.dataset.leaving = "true";
    item.el.setAttribute("aria-hidden", "true");
    item.el.inert = true;
    const from = Number(getComputedStyle(item.el).opacity) || 0;

    for (const a of item.el.getAnimations()) a.cancel();
    const frames = reduced.matches
      ? [{ opacity: from }, { opacity: 0 }]
      : [{ opacity: from, filter: "blur(0px)", transform: "translateY(0)" }, { opacity: 0, filter: "blur(3px)", transform: "translateY(-4px)" }];
    const anim = item.el.animate(frames, { duration: CONTENT_OUT_MS, fill: "forwards" });
    anim.onfinish = () => { item.el.remove(); items = items.filter(i => i !== item); };
  }

  /** 从右往左排：结尾按钮、右段、左段、图标；最左边留白，图标那侧少留一点。 */
  function layout(v: EdgeTabView, next: Item[]): number {
    const bySlot = new Map(next.map(i => [i.slot, i]));
    const order = (["end", "b", "a", "icon"] as const).flatMap(slot => bySlot.get(slot) ?? []);
    let x = bySlot.has("end") ? (v.end === "arrow" ? 12 : 7) : 14;

    order.forEach((it, i) => {
      it.x.to = x;
      x += it.width;
      const nextSlot = order[i + 1]?.slot;

      if (!nextSlot) x += it.slot === "icon" ? PADL - 4 : PADL;
      else x += it.slot === "b" && nextSlot === "a" ? (v.tight ? 0.5 : WGAP) : GAP;
    });

    return Math.round(x);
  }

  function render(next: EdgeTabView | null, nextOthers: EdgeTabOther[] = []): void {
    const was = view;
    view = next;
    others = next ? nextOthers : [];

    if (!next) {
      if (!open) return;
      open = false;
      host.dataset.shown = "false";

      for (const it of items) if (!it.leaving) fadeOut(it);
      closeAt = reduced.matches ? 0 : performance.now() + CONTENT_OUT_MS;
      setList(false);
      paintBubble();
      kick();

      return;
    }

    if (!attach()) return;
    root.hidden = false;
    const opening = !open;
    open = true;
    host.dataset.shown = "true";
    closeAt = 0;

    if (next.end !== "stop") stopPending = false;

    const kept: Item[] = [];

    for (const slot of ["icon", "a", "b", "end"] as const) {
      const key = slotKey(slot, next);
      const old = items.find(i => i.slot === slot && !i.leaving);

      if (old && key !== null && old.key === key) {
        kept.push(old);
        continue;
      }

      if (old) fadeOut(old);

      if (key === null) continue;
      kept.push(makeItem(slot, key, next));
    }

    // 读屏和复制按看到的顺序读：新字插到它后面那个字之前，不排在末尾。
    let after: Element | null = null;

    for (const it of [...kept].reverse()) {
      if (!items.includes(it)) { clip.insertBefore(it.el, after); fadeIn(it.el); }
      after = it.el;
    }

    const width = layout(next, kept);

    for (const it of kept) {
      const fresh = !items.includes(it);

      // 新出现的字直接落在它的位置上淡入；没变的字跟着形状平移过去。
      if (fresh || reduced.matches) it.x.snap(it.x.to);
      else it.x.aim(it.x.to, MORPH);
    }

    items = [...items.filter(i => i.leaving), ...kept];

    if (reduced.matches) {
      W.snap(width);
      Hs.snap(H);
    } else {
      const spring = opening ? OPEN : MORPH;
      W.aim(width, spring);
      Hs.aim(H, spring);
    }

    const text = next.lead ? `${next.a} ${next.b}` : `${next.a}${next.tight ? "" : " "}${next.b}`;
    clip.setAttribute("aria-label", next.hint ? `${text.trim()}，${next.hint}` : text.trim());
    clip.title = next.hint ?? "";

    if (!was || was.a !== next.a || was.b !== next.b) live.textContent = text.trim();

    paintBubble();
    kick();
  }

  function paintBubble(): void {
    const count = open ? others.length : 0;
    const first = others[0];
    const key = first ? `${first.id}|${first.title}|${count}` : "";

    if (!count) {
      BW.aim(0, CLOSE);
      BH.aim(BUBBLE_H, CLOSE);
      bub.inert = true;
      setList(false);

      return;
    }

    bub.inert = false;

    if (key !== bubbleKey) {
      bubbleKey = key;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = `+${count}`;
      bhead.replaceChildren(avatar(first!), n);
      bhead.setAttribute("aria-label", `另外 ${count} 位助手，展开列表`);
    }

    // 列表开着时只在内容变了才重画，保住键盘焦点和展开的详情。
    const rows = others.map(o => `${o.id}|${o.title}|${o.detail ?? ""}`).join("\n");

    if (listOpen && rows !== listRows) renderList();
    const width = listOpen ? PANEL_W : Math.round(8 + 18 + 5 + (bhead.querySelector<HTMLElement>(".n")?.offsetWidth ?? 14) + 10);
    const height = listOpen ? BUBBLE_H + Math.min(ROWS_MAX_H, list.scrollHeight) : BUBBLE_H;

    if (reduced.matches) { BW.snap(width); BH.snap(height); } else { BW.aim(width, BW.x < 1 ? OPEN : MORPH); BH.aim(height, MORPH); }
  }

  function kick(): void {
    if (raf !== undefined) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    raf = undefined;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;

    if (!open && closeAt && now >= closeAt) {
      closeAt = 0;
      W.aim(CLOSED.w, CLOSE);
      Hs.aim(CLOSED.h, CLOSE);
    }

    W.step(dt); Hs.step(dt); BW.step(dt); BH.step(dt);

    for (const it of items) it.x.step(dt);

    // 减少动态效果：形状不伸缩，只整体淡入淡出。
    if (reduced.matches) {
      const step = dt / (FADE_MS / 1000);
      fade = open ? Math.min(1, fade + step) : Math.max(0, fade - step);
    } else {
      fade = clamp01((W.x - CLOSED.w) / 14);
    }

    paint();
    const settled = W.still && Hs.still && BW.still && BH.still && items.every(i => i.x.still) && !closeAt && fade === (open ? 1 : 0);

    if (!open && settled) {
      W.snap(CLOSED.w);
      Hs.snap(CLOSED.h);
      root.hidden = true;
      clip.replaceChildren();
      items = [];
      bhead.replaceChildren();
      list.replaceChildren();
      listRows = "";
      bubbleKey = "";

      return;
    }

    if (!settled || items.some(i => i.leaving)) raf = requestAnimationFrame(frame);
  }

  function paint(): void {
    const w = W.x;
    const h = Hs.x;
    const isDark = dark.matches;
    const k = clamp01((w - 20) / 120);
    mainShape!.setAttribute("d", shapePath(X, w, h, MID, 9));
    mainHair!.setAttribute("d", hairPath(X, w, h, MID));
    root.style.opacity = reduced.matches ? String(fade) : "";
    mainShape!.style.opacity = mainHair!.style.opacity = String(reduced.matches ? 1 : fade);

    const shc = isDark ? "#000" : "oklch(32% 0.06 285)";
    const so = isDark ? [0.3, 0.22, 0.2] : [0.07, 0.07, 0.09];
    shadows.forEach((s, i) => { s.setAttribute("flood-color", shc); s.setAttribute("flood-opacity", String(so[i]! * k)); });
    const hairColor = isDark ? "#fff" : "#000";
    const ho = isDark ? [0.18, 0.05, 0.08] : [0.09, 0.03, 0.05];
    hairStops.forEach((s, i) => { s.setAttribute("stop-color", hairColor); s.setAttribute("stop-opacity", String(ho[i]! * k)); });

    Object.assign(clip.style, { left: `${X - w}px`, top: `${MID - h / 2}px`, width: `${Math.max(0, w - 1)}px`, height: `${h}px` });

    for (const it of items) it.el.style.right = `${it.x.x}px`;

    const bw = BW.x;
    const bh = BH.x;
    const btop = MID + H / 2 + BUBBLE_GAP;
    const bmid = btop + bh / 2;
    bubShape!.setAttribute("d", bw > 0.5 ? shapePath(X, bw, bh, bmid, 7, BUBBLE_R) : "");
    bubHair!.setAttribute("d", bw > 0.5 ? hairPath(X, bw, bh, bmid, BUBBLE_R) : "");
    bubShape!.style.opacity = bubHair!.style.opacity = String(clamp01(bw / 20));
    Object.assign(bub.style, { left: `${X - bw}px`, top: `${btop}px`, width: `${Math.max(0, bw - 1)}px`, height: `${bh}px`, visibility: bw > 0.5 ? "visible" : "hidden" });
  }

  // 窗口宽度变了，画布仍贴右边；只需要重画一帧。系统深浅色切换时阴影和细边跟着换。
  dark.addEventListener("change", () => { if (open) paint(); });

  function rectOf(el: Element): { x: number; y: number; width: number; height: number } {
    const r = el.getBoundingClientRect();

    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  return {
    render,
    /** 页面卸载或换世界：动画停掉、节点拿走。 */
    destroy(): void {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      host.remove();
    },
    attach,
    state(): EdgeTabState {
      const end = view?.end;
      const shownRect = open && !root.hidden ? rectOf(clip) : null;

      return {
        shown: open,
        tone: open ? view?.tone ?? null : null,
        a: open ? view?.a ?? "" : "",
        b: open ? view?.b ?? "" : "",
        end: !open || !end ? null : typeof end === "string" ? end : end.label,
        endEnabled: Boolean(open && end && (typeof end === "string" || end.enabled)),
        width: W.to,
        rect: shownRect,
        panel: getComputedStyle(root).getPropertyValue("--panel").trim(),
        bubble: open && others.length ? { count: others.length, letter: bhead.querySelector(".av")?.textContent ?? "", rect: rectOf(bhead), panel: rectOf(bub) } : null,
        list: { open: listOpen, rows: listOpen ? Array.from(list.querySelectorAll<HTMLElement>("button.row"), (row, i) => ({ name: others[i]?.name ?? "", title: others[i]?.title ?? "", local: Boolean(others[i]?.local), rect: rectOf(row) })) : [] },
        button: open ? (b => b ? rectOf(b) : null)(clip.querySelector("button")) : null,
        icon: open && items.some(i => i.slot === "icon" && !i.leaving),
        shimmer: open && (t => Boolean(t) && getComputedStyle(t!).animationName === "shim" && t!.getAnimations().some(a => a.playState === "running"))(clip.querySelector<HTMLElement>(".el:not([data-leaving]) .shim")),
      };
    },
    /** 验收脚本用：按部位点一下（和真人点同一个处理函数）。 */
    click(part: "capsule" | "stop" | "action" | "bubble" | number): boolean {
      if (!open) return false;

      if (part === "capsule") { clip.click(); return true; }

      if (part === "bubble") { if (!others.length) return false; bhead.click(); return true; }

      if (typeof part === "number") {
        const row = list.querySelectorAll<HTMLButtonElement>("button.row")[part];
        row?.click();

        return Boolean(row);
      }
      const btn = clip.querySelector<HTMLButtonElement>(part === "stop" ? "button.stop" : "button.act");

      if (!btn || btn.disabled) return false;
      btn.click();

      return true;
    },
  };
}

export type EdgeTab = ReturnType<typeof createEdgeTab>;
