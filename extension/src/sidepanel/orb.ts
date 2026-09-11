/**
 * 执行面板里的光球。
 *
 * 几何来自 thinking-orbs（见 ../vendor/thinking-orbs.js，MIT），这里只负责：
 * 取帧、按产品色上色、以及"什么时候在动"。
 *
 * 三个约定，改动前先读：
 * 1. 只有正在跑的那几个球占 rAF；跑完定格成 STILL_T 一帧，不再耗电。
 * 2. 颜色跟着 --text-secondary 走，深色模式自动反相；主题切换会重画静止的球。
 * 3. 用户在系统里开了"减少动态"就一律定格——光球是状态提示，不是必须动的装饰。
 */
import { MODE_FRAMES, resolvePreset } from "../vendor/thinking-orbs.js";

/** 产品只用这三个身份：思考、调工具、用记忆。 */
export type OrbState = "composing" | "solving" | "connecting";

/** 引擎的几何坐标系固定 20；显示尺寸靠 canvas 缩放，别改这里。 */
const GEOM = 20;
/** 定格帧。跑完停在它的一个相位上，形态仍然可辨（不是空帧）。 */
const STILL_T = 0.6;

type Rgb = [number, number, number];

type OrbInstance = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  preset: ReturnType<typeof resolvePreset>;
  box: number;
  dpr: number;
  running: boolean;
  /** 本次起跑的时间原点（秒） */
  t0: number;
  /** 之前累计跑过的秒数，续跑时接着走，不跳帧 */
  offset: number;
};

const instances = new Set<OrbInstance>();
let raf = 0;
let probeCtx: CanvasRenderingContext2D | null | undefined;
let cachedInk: Rgb | null = null;
let inkResolved = false;
let themeBound = false;

function prefersReduce(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * 取色：解析 --orb-ink 成 RGB，解析不了就退回 --text-secondary，再不行返回 null（灰色兜底）。
 * 球是细线，上色时还要乘 alpha——用次要文字色会被稀释到几乎看不见，所以单独留了 token。
 */
function readInk(): Rgb | null {
  const style = getComputedStyle(document.body);
  const raw = (
    style.getPropertyValue("--orb-ink").trim() || style.getPropertyValue("--text-secondary").trim()
  );
  if (!raw) return null;
  if (probeCtx === undefined) probeCtx = document.createElement("canvas").getContext("2d");
  if (!probeCtx) return null;
  probeCtx.fillStyle = "#000";
  probeCtx.fillStyle = raw;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(probeCtx.fillStyle);
  if (!m) return null;
  const [, r, g, b] = m;
  if (!r || !g || !b) return null;
  return [parseInt(r, 16), parseInt(g, 16), parseInt(b, 16)];
}

function ink(): Rgb | null {
  if (!inkResolved) {
    cachedInk = readInk();
    inkResolved = true;
  }
  return cachedInk;
}

/** 引擎把每个笔画/点标成"白度"，这里换算成当前主题下的 alpha。 */
function shade(color: Rgb | null, white: number, alpha: number, dark: boolean): string {
  const v = dark ? 1 - white : white;
  if (!color) {
    const l = Math.round((dark ? 1 - v : v) * 255);
    return `rgba(${l},${l},${l},${alpha})`;
  }
  return `rgba(${color[0]},${color[1]},${color[2]},${(alpha * (1 - v)).toFixed(3)})`;
}

function paint(o: OrbInstance, engineT: number): void {
  const color = ink();
  const dark = prefersDark();
  const frameOf = MODE_FRAMES[o.preset.mode];
  if (!frameOf) return;
  const frame = frameOf(GEOM, engineT, o.preset.opts);
  const k = (o.dpr * o.box) / GEOM;
  const ctx = o.ctx;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, GEOM, GEOM);
  for (const line of frame.lines) {
    ctx.strokeStyle = shade(color, line.white, line.a ?? 1, dark);
    ctx.lineWidth = line.w;
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.stroke();
  }
  for (const dot of frame.dots) {
    ctx.fillStyle = shade(color, dot.white, dot.a ?? 1, dark);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintStill(o: OrbInstance): void {
  paint(o, STILL_T);
}

function tick(now: number): void {
  raf = 0;
  const seconds = now / 1000;
  let anyLive = false;
  for (const o of instances) {
    if (!o.running) continue;
    anyLive = true;
    paint(o, (seconds - o.t0 + o.offset) * o.preset.speed);
  }
  if (anyLive) raf = requestAnimationFrame(tick);
}

function ensureLoop(): void {
  if (!raf) raf = requestAnimationFrame(tick);
}

function bindTheme(): void {
  if (themeBound) return;
  themeBound = true;
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    inkResolved = false;
    for (const o of instances) {
      if (!o.running) paintStill(o);
    }
  });
}

export type OrbHandle = {
  el: HTMLCanvasElement;
  /** 切到运行态就开始转，切回静止定格一帧并让出 rAF */
  setRunning(running: boolean): void;
  dispose(): void;
};

/**
 * 建一个球。state 决定形态，box 是 CSS 像素直径。
 * 返回的 canvas 直接塞进目标容器；不跑的时候它只是一张静止的画。
 */
export function createOrb(state: OrbState, box = 20): OrbHandle {
  bindTheme();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  canvas.style.width = `${box}px`;
  canvas.style.height = `${box}px`;
  canvas.setAttribute("aria-hidden", "true");

  const ctx = canvas.getContext("2d");
  if (!ctx) return { el: canvas, setRunning: () => {}, dispose: () => {} };

  const instance: OrbInstance = {
    canvas,
    ctx,
    preset: resolvePreset(state, GEOM),
    box,
    dpr,
    running: false,
    t0: 0,
    offset: 0,
  };
  instances.add(instance);
  paintStill(instance);

  return {
    el: canvas,
    setRunning(running: boolean): void {
      const next = running && !prefersReduce();
      if (next === instance.running) return;
      if (next) {
        instance.running = true;
        instance.t0 = performance.now() / 1000;
        // 跑起来才呼吸（18→20px），历史回放不进入这个状态
        canvas.classList.remove("orb-settle");
        canvas.classList.add("orb-live");
        ensureLoop();
        return;
      }
      instance.offset += performance.now() / 1000 - instance.t0;
      instance.running = false;
      paintStill(instance);
      canvas.classList.remove("orb-live");
      // 完成是收束：从呼吸处的放大缩回原位，一次性，不排队
      if (!prefersReduce()) {
        canvas.classList.remove("orb-settle");
        canvas.classList.add("orb-settle");
        // 用定时器摘 class 而不是 animationend：折叠的 details 里动画不启动，事件不会来。
        window.setTimeout(() => canvas.classList.remove("orb-settle"), 400);
      }
    },
    dispose(): void {
      instances.delete(instance);
    },
  };
}
