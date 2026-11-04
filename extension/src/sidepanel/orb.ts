import type { RunOrbState } from "./run-orb.js";
import { MODE_FRAMES, resolvePreset } from "../vendor/thinking-orbs.js";

export type OrbState = "composing" | "solving" | "connecting" | "reading" | RunOrbState;

const STATE_PRESET: Partial<Record<OrbState, string>> = {
  thinking: "solving", reading: "searching", executing: "working", waiting: "breathing",
};

const TERMINAL_STATES = new Set<OrbState>(["user", "completed", "failed", "stopped"]);

function presetFor(state: OrbState) {
  return resolvePreset(STATE_PRESET[state] ?? (TERMINAL_STATES.has(state) ? "solving" : state), GEOM);
}

const GEOM = 20;

const STILL_T = 0.6;

type Rgb = [number, number, number];

type OrbInstance = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  preset: ReturnType<typeof resolvePreset>;
  box: number;
  dpr: number;
  running: boolean;
  requestedRunning: boolean;
  refreshMotion(): void;
  state: OrbState;
  strong: boolean;
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

function readInk(token = "--orb-ink"): Rgb | null {
  const style = getComputedStyle(document.body);

  const raw = (
    style.getPropertyValue(token).trim() || style.getPropertyValue("--text-secondary").trim()
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

let cachedStrong: Rgb | null | undefined;

function strongInk(): Rgb | null {
  if (cachedStrong === undefined) cachedStrong = readInk("--text-primary");

  return cachedStrong;
}

function ink(): Rgb | null {
  if (!inkResolved) {
    cachedInk = readInk();
    inkResolved = true;
  }

  return cachedInk;
}

function shade(color: Rgb | null, white: number, alpha: number, dark: boolean, fade = 1): string {
  const v = (dark ? 1 - white : white) * fade;

  if (!color) {
    const l = Math.round((dark ? 1 - v : v) * 255);

    return `rgba(${l},${l},${l},${alpha})`;
  }

  return `rgba(${color[0]},${color[1]},${color[2]},${(alpha * (1 - v)).toFixed(3)})`;
}

const STRONG = { fade: 0.45, alpha: 1.3, line: 1.2, dot: 1.15 };

function paint(o: OrbInstance, engineT: number): void {
  const color = o.strong ? strongInk() : ink();
  const weight = o.strong ? STRONG : { fade: 1, alpha: 1, line: 1, dot: 1 };
  const dark = prefersDark();
  const frameOf = MODE_FRAMES[o.preset.mode];

  if (!frameOf) return;
  const frame = frameOf(GEOM, engineT, o.preset.opts);
  const k = (o.dpr * o.box) / GEOM;
  const ctx = o.ctx;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, GEOM, GEOM);

  for (const line of frame.lines) {
    ctx.strokeStyle = shade(color, line.white, Math.min(1, (line.a ?? 1) * weight.alpha), dark, weight.fade);
    ctx.lineWidth = line.w * weight.line;
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.stroke();
  }

  for (const dot of frame.dots) {
    ctx.fillStyle = shade(color, dot.white, Math.min(1, (dot.a ?? 1) * weight.alpha), dark, weight.fade);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r * weight.dot, 0, Math.PI * 2);
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
    if (!o.canvas.isConnected) { instances.delete(o); continue; }

    if (!o.running) continue;
    anyLive = true;
    paint(o, seconds * o.preset.speed);
  }

  if (anyLive) raf = requestAnimationFrame(tick);
}

function ensureLoop(): void {
  if (!raf) raf = requestAnimationFrame(tick);
}

function bindTheme(): void {
  if (themeBound) return;
  themeBound = true;
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => {
    for (const o of instances) o.refreshMotion();
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    inkResolved = false;
    cachedStrong = undefined;

    for (const o of instances) {
      if (!o.running) paintStill(o);
    }
  });
}

export type OrbHandle = {
  el: HTMLCanvasElement;
  setState(state: OrbState): void;
  setRunning(running: boolean): void;
  dispose(): void;
};

export function createOrb(state: OrbState, box = 20, strong = false): OrbHandle {
  bindTheme();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  canvas.style.width = `${box}px`;
  canvas.style.height = `${box}px`;
  canvas.setAttribute("aria-hidden", "true");

  const ctx = canvas.getContext("2d");

  if (!ctx) return { el: canvas, setState: () => {}, setRunning: () => {}, dispose: () => {} };

  const instance: OrbInstance = {
    canvas,
    ctx,
    preset: presetFor(state),
    state,
    requestedRunning: false,
    refreshMotion: () => {},
    box,
    dpr,
    running: false,
    strong,
  };

  canvas.dataset.orbState = state;
  canvas.dataset.orbMode = instance.preset.mode;
  instances.add(instance);
  paintStill(instance);

  const handle: OrbHandle = {
    el: canvas,
    setState(nextState: OrbState): void {
      if (instance.state === nextState) return;
      instance.state = nextState;
      canvas.dataset.orbState = nextState;

      if (!TERMINAL_STATES.has(nextState)) {
        instance.preset = presetFor(nextState);
        canvas.dataset.orbMode = instance.preset.mode;
        paint(instance, prefersReduce() ? STILL_T : performance.now() / 1000 * instance.preset.speed);
      }
    },
    setRunning(running: boolean): void {
      instance.requestedRunning = running;
      const next = running && !prefersReduce();

      if (next === instance.running) return;

      if (next) {
        instance.running = true;
        canvas.classList.remove("orb-settle");
        canvas.classList.add("orb-live");
        ensureLoop();

        return;
      }

      instance.running = false;

      if (prefersReduce() || !TERMINAL_STATES.has(instance.state)) paintStill(instance);
      canvas.classList.remove("orb-live");

      if (!prefersReduce() && !["stopped", "user", "failed"].includes(instance.state)) {
        canvas.classList.remove("orb-settle");
        canvas.classList.add("orb-settle");
        window.setTimeout(() => canvas.classList.remove("orb-settle"), 400);
      }
    },
    dispose(): void {
      instance.running = false;
      instances.delete(instance);
    },
  };

  instance.refreshMotion = () => handle.setRunning(instance.requestedRunning);

  return handle;
}
