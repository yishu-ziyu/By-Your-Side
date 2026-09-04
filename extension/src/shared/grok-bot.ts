/**
 * LaoA-GrokBot 弹簧：眨眼、眼神、表情过渡。不新写 path。
 * 休息时身体不漂（bloub）；reduced-motion 停眼和过渡。
 */
import { GROKBOT_ORIGINAL } from "./grok-original.js";
import type { CastShape, Person } from "../../../shared/cast.js";

const SHAPES: Record<CastShape, string> = {
  blob: "M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z",
  pebble: "M114 8C177 8 217 45 217 109C217 178 181 219 112 219C43 219 12 181 12 113C12 48 51 8 114 8Z",
  squircle: "M55 10H174Q219 10 219 55V174Q219 219 174 219H55Q10 219 10 174V55Q10 10 55 10Z",
  capsule: "M61 31H168C202 31 220 65 220 114C220 163 202 197 168 197H61C27 197 9 163 9 114C9 65 27 31 61 31Z",
  hex: "M114 5L207 58Q218 64 218 78V153Q218 167 207 173L128 218Q114 226 100 218L21 173Q10 167 10 153V78Q10 64 21 58L100 12Q114 5 114 5Z",
  triangle: "M114 9Q122 9 128 21L220 194Q227 210 207 210H21Q1 210 9 194L101 21Q106 9 114 9Z",
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const xOf = (p: number[] | undefined) => p?.[0] ?? 0;
const yOf = (p: number[] | undefined) => p?.[1] ?? 0;
const mixPt = (a: number[], b: number[] | undefined, t: number): [number, number] => {
  const ax = xOf(a);
  const ay = yOf(a);
  return [ax + (xOf(b) - ax) * t, ay + (yOf(b) - ay) * t];
};
const ringPath = (ring: number[][]) =>
  "M" + ring.map((p) => `${xOf(p).toFixed(2)} ${yOf(p).toFixed(2)}`).join("L") + "Z";
const centroid = (ring: number[][]): [number, number] => {
  const n = ring.length || 1;
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += xOf(p) / n;
    y += yOf(p) / n;
  }
  return [x, y];
};
const cloneExpr = (expr: number[][][]) => expr.map((r) => r.map((p) => [xOf(p), yOf(p)]));

let clip = 0;
const live = new Set<GrokBot>();
let raf = 0;
let last = 0;

function reduceMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function loop(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  for (const bot of live) bot.tick(now, dt);
  raf = live.size ? requestAnimationFrame(loop) : 0;
}

function ensureLoop(): void {
  if (raf || live.size === 0) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

export interface GrokHandle {
  destroy(): void;
  setWaiting(waiting: boolean): void;
}

class GrokBot {
  private svg: SVGSVGElement;
  private eye0: SVGPathElement;
  private eye1: SVGPathElement;
  private pool: number[];
  private mood: Person["mood"];
  private expr: number;
  private current: number[][][];
  private target: number[][][];
  private morph = 1;
  private vel = 0;
  private blink = 1;
  private blinkStart = 0;
  private gazeX = 0;
  private gazeY = 0;
  private gx = 0;
  private gy = 0;
  private nextBlink = 0;
  private nextExpr = 0;
  private nextGaze = 0;
  private nextTilt = 0;
  private waiting = false;

  constructor(svg: SVGSVGElement, person: Person) {
    this.svg = svg;
    const e0 = svg.querySelector(".e0");
    const e1 = svg.querySelector(".e1");
    if (!(e0 instanceof SVGPathElement) || !(e1 instanceof SVGPathElement)) {
      throw new Error("grok eyes missing");
    }
    this.eye0 = e0;
    this.eye1 = e1;
    this.pool = [...person.pool];
    this.mood = person.mood;
    this.expr = person.expr;
    const rings = GROKBOT_ORIGINAL.EXPRESSIONS[person.expr];
    if (!rings) throw new Error(`missing expression ${person.expr}`);
    this.current = cloneExpr(rings);
    this.target = rings;
    const now = performance.now();
    this.nextBlink = now + 600 + Math.random() * 2000;
    this.nextExpr = now + 900 + Math.random() * 1600;
    this.nextGaze = now;
    this.nextTilt = now + 1600 + Math.random() * 2000;
    this.draw();
  }

  setWaiting(waiting: boolean): void {
    this.waiting = waiting;
  }

  private choose(i: number): void {
    const t = clamp(this.morph, 0, 1);
    this.current = this.current.map((ring, e) =>
      ring.map((p, j) => mixPt(p, this.target[e]?.[j], t)),
    );
    const next = GROKBOT_ORIGINAL.EXPRESSIONS[i];
    if (!next) return;
    this.target = next;
    this.expr = i;
    this.morph = 0;
    this.vel = 0;
  }

  tick(now: number, dt: number): void {
    if (reduceMotion()) {
      this.morph = 1;
      this.blink = 1;
      this.draw();
      return;
    }
    this.vel += (-14 * this.vel - 49 * (this.morph - 1)) * dt;
    this.morph += this.vel * dt;
    if (!Number.isFinite(this.morph)) {
      this.morph = 1;
      this.vel = 0;
    }
    if (now > this.nextBlink) {
      this.blinkStart = now;
      this.nextBlink = now + 2600 + Math.random() * 3400;
    }
    if (this.blinkStart) {
      const t = (now - this.blinkStart) / 320;
      if (t >= 1) {
        this.blinkStart = 0;
        this.blink = 1;
      } else this.blink = Math.max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04);
    }
    if (this.pool.length > 1 && now > this.nextExpr) {
      const next = this.pool.find((i) => i !== this.expr) ?? this.pool[0] ?? this.expr;
      this.choose(next);
      this.nextExpr = now + (this.waiting || this.mood === "wait" ? 2800 : 1500) + Math.random() * 1800;
    }
    if (now > this.nextGaze) {
      const amp = this.waiting || this.mood === "wait" ? 6 : 16;
      this.gx = (Math.random() - 0.5) * amp;
      this.gy = (Math.random() - 0.5) * amp * 0.6;
      this.nextGaze = now + 800 + Math.random() * 1400;
    }
    this.gazeX += (this.gx - this.gazeX) * Math.min(1, dt * 3);
    this.gazeY += (this.gy - this.gazeY) * Math.min(1, dt * 3);
    if (this.mood === "play" && !this.waiting && now > this.nextTilt) {
      this.svg.classList.remove("tilt-once");
      void this.svg.getBoundingClientRect();
      this.svg.classList.add("tilt-once");
      this.nextTilt = now + 3800 + Math.random() * 3200;
    }
    this.draw();
  }

  draw(): void {
    const t = clamp(this.morph, 0, 1);
    const shown = this.current.map((ring, e) =>
      ring.map((p, j) => mixPt(p, this.target[e]?.[j], t)),
    );
    [this.eye0, this.eye1].forEach((el, i) => {
      const ring = shown[i];
      if (!ring) return;
      const c = centroid(ring);
      const x = c[0] + this.gazeX;
      const y = c[1] + this.gazeY;
      el.setAttribute("d", ringPath(ring));
      el.setAttribute(
        "transform",
        `translate(${x} ${y}) scale(1 ${this.blink}) translate(${-c[0]} ${-c[1]})`,
      );
    });
  }

  destroy(): void {
    live.delete(this);
    this.svg.remove();
  }
}

export function mountGrok(host: HTMLElement, person: Person, size = 28): GrokHandle {
  host.replaceChildren();
  const id = `gb${++clip}`;
  const d = SHAPES[person.shape];
  host.innerHTML = `<svg class="gb" width="${size}" height="${size}" viewBox="0 0 229 229" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="${d}"/></clipPath></defs>
    <path fill="${person.color}" d="${d}"/>
    <g clip-path="url(#${id})">
      <path class="e0" fill="#fff"/>
      <path class="e1" fill="#fff"/>
    </g>
  </svg>`;
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("grok svg missing");
  const bot = new GrokBot(svg, person);
  live.add(bot);
  ensureLoop();
  return {
    destroy() {
      bot.destroy();
      host.replaceChildren();
    },
    setWaiting(waiting: boolean) {
      bot.setWaiting(waiting);
    },
  };
}

export function mountKenney(host: HTMLElement, bodyUrl: string, faceUrl: string, size = 28): void {
  host.replaceChildren();
  const el = document.createElement("span");
  el.className = "kn live";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.setProperty("--body", `url("${bodyUrl}")`);
  el.style.setProperty("--face", `url("${faceUrl}")`);
  el.innerHTML = "<i></i>";
  host.appendChild(el);
}

/** 表情插值（单测用）：t=0 起点，t=1 终点。 */
export function lerpExpr(from: number[][][], to: number[][][], t: number): number[][][] {
  const k = clamp(t, 0, 1);
  return from.map((ring, e) => ring.map((p, j) => mixPt(p, to[e]?.[j], k)));
}
