/**
 * Reicon 形 M 伴侣：圆角 V + 官网竖眼，趴在 Composer / 气泡外沿。
 *
 * 沿边是走不是瞬移；跳前先蹲；长消息会愣；闲时休息多于乱动。
 * 坐标锁在卡片外沿，不进内文。
 */

export type CompanionPose = "idle" | "lean" | "walk";

export interface CompanionOptions {
  appEl: HTMLElement;
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  messagesEl: HTMLElement;
  pagePillEl?: HTMLElement | null;
  /** 兼容旧 harness，SVG 伴侣不再读盘。 */
  spriteBase?: string;
}

export interface Box {
  top: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export const SPRITE_W = 36;
export const SPRITE_H = 36;
export const RIM_GAP = 32;
export const LEAN_GAP = 28;
/** 允许搭在边框上的最大重叠；必须小于气泡 padding（用户气泡 9px）。 */
export const PAW_OVERLAP = 6;

const BODY = "M 30 128 L 30 22 L 66 72 C 70 84 80 84 84 72 L 120 22 L 120 128";
const STROKE = 46;
const EYES: Array<[number, number, number, number]> = [
  [50, 50, 9.5, 19],
  [100, 50, 9.5, 19],
];

export function reduceMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isLongMessage(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length >= 40 || text.split("\n").length >= 3;
}

function toBox(r: DOMRect): Box {
  return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export function mascotSvg(maskId = "m-eyes"): string {
  const holes = EYES.map(
    ([cx, cy, rx, ry]) =>
      `<ellipse class="pix-eye" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000"/>`,
  ).join("");
  return `<svg viewBox="0 0 150 150" aria-hidden="true">
    <defs>
      <mask id="${maskId}" maskUnits="userSpaceOnUse">
        <rect width="150" height="150" fill="#fff"/>${holes}
      </mask>
    </defs>
    <g mask="url(#${maskId})">
      <path d="${BODY}" fill="none" stroke="currentColor" stroke-width="${STROKE}"
        stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`;
}

export function composerIdleAnchor(
  composer: Box,
  app: { top: number; left: number },
  pill?: Box | null,
): { top: number; left: number } {
  const top = composer.top - app.top - RIM_GAP;
  let left = composer.left - app.left + 22;
  if (pill) left = Math.max(left, pill.right - app.left + 6);
  const maxLeft = composer.right - app.left - SPRITE_W - 8;
  const minLeft = composer.left - app.left + 8;
  return { top, left: Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft)) };
}

export function rimAnchor(
  target: Box,
  app: { top: number; left: number },
  kind: "lean" | "bubble" | "step",
  bounds?: { minTop: number; minLeft: number; maxLeft: number },
): { top: number; left: number } {
  let top = target.top - app.top - (kind === "lean" ? LEAN_GAP : RIM_GAP);
  let left: number;
  if (kind === "lean") left = target.left - app.left + 8;
  else if (kind === "bubble") left = target.left - app.left - 2;
  else left = target.left - app.left + 10;

  if (bounds && top < bounds.minTop) {
    top = bounds.minTop;
    const leftSide = target.left - app.left - SPRITE_W - 4;
    if (leftSide >= bounds.minLeft) left = leftSide;
  }
  if (bounds) {
    top = Math.max(top, bounds.minTop);
    left = Math.min(Math.max(left, bounds.minLeft), bounds.maxLeft);
  }
  return { top, left };
}

export function topRimAnchor(
  target: Box,
  app: { top: number; left: number },
  t: number,
  spriteW = SPRITE_W,
  rimGap = RIM_GAP,
): { top: number; left: number } {
  const top = target.top - app.top - rimGap;
  const minLeft = target.left - app.left + 8;
  const maxLeft = target.right - app.left - spriteW - 8;
  const span = Math.max(0, maxLeft - minLeft);
  const clamped = Math.min(1, Math.max(0, t));
  return { top, left: minLeft + clamped * span };
}

/** actor 与卡片内文区是否相交。内文区 = 卡片减去 contentInset。 */
export function overlapsContent(actor: Box, card: Box, contentInset = 8): boolean {
  const cTop = card.top + contentInset;
  const cLeft = card.left + contentInset;
  const cRight = card.right - contentInset;
  const cBottom = card.top + card.height - contentInset;
  const aBottom = actor.top + actor.height;
  const aRight = actor.left + actor.width;
  return actor.left < cRight && aRight > cLeft && actor.top < cBottom && aBottom > cTop;
}

export class SideCompanion {
  private appEl: HTMLElement;
  private composerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private messagesEl: HTMLElement;
  private pagePillEl: HTMLElement | null;

  private hostEl: HTMLElement;
  private squashEl: HTMLElement;

  private seq = 0;
  private lastFidget = "";
  private isPressing = false;
  private isVisiting = false;
  private visitTarget: HTMLElement | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private onResize: () => void;
  private onScroll: () => void;
  private onPointerUp: () => void = () => {};
  private reduced: boolean;

  constructor(options: CompanionOptions) {
    this.appEl = options.appEl;
    this.composerEl = options.composerEl;
    this.inputEl = options.inputEl;
    this.messagesEl = options.messagesEl;
    this.pagePillEl = options.pagePillEl ?? null;
    this.reduced = reduceMotion();

    this.hostEl = document.createElement("div");
    this.hostEl.className = "pix-actor-host";
    this.hostEl.id = "pix-companion";
    this.hostEl.setAttribute("title", "摸摸我");
    this.hostEl.setAttribute("aria-hidden", "true");

    this.squashEl = document.createElement("div");
    this.squashEl.className = "pix-squash";
    this.squashEl.innerHTML = mascotSvg();
    this.hostEl.appendChild(this.squashEl);
    this.appEl.appendChild(this.hostEl);

    this.bindGestures();
    this.bindInputListeners();

    this.onResize = () => {
      if (!this.isVisiting) this.resetToComposer();
      else this.placeOnVisitTarget();
    };
    this.onScroll = () => {
      if (this.isVisiting) this.placeOnVisitTarget();
    };
    window.addEventListener("resize", this.onResize);
    this.messagesEl.addEventListener("scroll", this.onScroll, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.composerEl);
    }

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.resetToComposer();
        this.scheduleIdle();
      }),
    );
  }

  private bump(): number {
    this.seq += 1;
    this.clearTimers();
    this.hostEl.classList.remove("walking", "surprise", "nod");
    return this.seq;
  }

  private alive(token: number): boolean {
    return token === this.seq;
  }

  private visitBounds(): { minTop: number; minLeft: number; maxLeft: number } {
    const app = this.appOrigin();
    const topbar = this.appEl.querySelector("#topbar");
    const msg = this.boxOf(this.messagesEl);
    const minTop = topbar
      ? Math.max(0, topbar.getBoundingClientRect().bottom - app.top + 2)
      : Math.max(0, msg.top - app.top);
    return {
      minTop,
      minLeft: 8,
      maxLeft: this.appEl.clientWidth - SPRITE_W - 8,
    };
  }

  private later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  private appOrigin(): { top: number; left: number } {
    const r = this.appEl.getBoundingClientRect();
    return { top: r.top, left: r.left };
  }

  private boxOf(el: HTMLElement): Box {
    return toBox(el.getBoundingClientRect());
  }

  private currentPos(): { top: number; left: number } {
    return {
      top: parseFloat(this.hostEl.style.top) || 0,
      left: parseFloat(this.hostEl.style.left) || 0,
    };
  }

  private put(pos: { top: number; left: number }, rot = 0): void {
    this.hostEl.style.top = `${Math.round(pos.top)}px`;
    this.hostEl.style.left = `${Math.round(pos.left)}px`;
    this.hostEl.style.transform = rot ? `rotate(${rot}deg)` : "none";
  }

  private topPos(el: HTMLElement, t: number): { top: number; left: number } {
    const box = this.boxOf(el);
    const app = this.appOrigin();
    let pos = topRimAnchor(box, app, t);
    if (el === this.composerEl && this.pagePillEl) {
      const pill = this.boxOf(this.pagePillEl);
      pos = { ...pos, left: Math.max(pos.left, pill.right - app.left + 6) };
    }
    const bounds = this.visitBounds();
    if (pos.top < bounds.minTop) {
      pos = {
        top: bounds.minTop,
        left: Math.max(bounds.minLeft, box.left - app.left - SPRITE_W - 4),
      };
    }
    return {
      top: Math.max(pos.top, bounds.minTop),
      left: Math.min(Math.max(pos.left, bounds.minLeft), bounds.maxLeft),
    };
  }

  private async animateTo(
    dest: { top: number; left: number },
    token: number,
    extraMs = 0,
    rot = 0,
  ): Promise<void> {
    if (this.reduced) {
      this.put(dest, rot);
      return;
    }
    const start = this.currentPos();
    const dist = Math.hypot(dest.top - start.top, dest.left - start.left);
    const dur = Math.max(extraMs, dist * 3.4);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        if (!this.alive(token)) {
          resolve();
          return;
        }
        const p = Math.min(1, (now - t0) / dur);
        const e = easeInOut(p);
        this.put(
          {
            top: start.top + (dest.top - start.top) * e,
            left: start.left + (dest.left - start.left) * e,
          },
          rot * e,
        );
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private async anticipate(token: number): Promise<void> {
    if (this.reduced) return;
    this.hostEl.classList.add("pressing");
    await this.wait(180);
    if (this.alive(token)) this.hostEl.classList.remove("pressing");
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async alongTop(el: HTMLElement, fromT: number, toT: number, token: number): Promise<void> {
    this.hostEl.classList.add("walking");
    const steps = 3;
    for (let i = 1; i <= steps; i++) {
      if (!this.alive(token)) return;
      const t = fromT + (toT - fromT) * (i / steps);
      await this.animateTo(this.topPos(el, t), token, 280);
    }
    if (this.alive(token)) this.hostEl.classList.remove("walking");
  }

  public resetToComposer(): void {
    this.isVisiting = false;
    this.visitTarget = null;
    this.hostEl.classList.remove("walking", "surprise", "nod");
    const pos = composerIdleAnchor(
      this.boxOf(this.composerEl),
      this.appOrigin(),
      this.pagePillEl ? this.boxOf(this.pagePillEl) : null,
    );
    this.put(pos);
  }

  public triggerLean(): void {
    if (this.isVisiting) return;
    const token = this.seq;
    const composer = this.boxOf(this.composerEl);
    const app = this.appOrigin();
    const pill = this.pagePillEl ? this.boxOf(this.pagePillEl) : null;
    const idle = composerIdleAnchor(composer, app, pill);
    let lean = rimAnchor(composer, app, "lean");
    if (pill && lean.left + SPRITE_W > pill.left - app.left && lean.left < pill.right - app.left) {
      lean = idle;
    }
    void this.animateTo(lean, token, 500, -11);
  }

  private bindGestures(): void {
    this.hostEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.bump();
      this.isPressing = true;
      this.hostEl.classList.add("pressing");
    });
    this.onPointerUp = () => {
      if (!this.isPressing) return;
      this.isPressing = false;
      this.hostEl.classList.remove("pressing");
      if (!this.reduced) this.hostEl.classList.add("rebounding");
      this.later(this.reduced ? 80 : 640, () => {
        this.hostEl.classList.remove("rebounding");
      });
    };
    window.addEventListener("pointerup", this.onPointerUp);
  }

  private bindInputListeners(): void {
    this.inputEl.addEventListener("focus", () => this.triggerLean());
    this.inputEl.addEventListener("blur", () => {
      this.hostEl.classList.remove("surprise");
      this.later(550, () => {
        if (!this.isVisiting && document.activeElement !== this.inputEl) {
          this.resetToComposer();
        }
      });
    });
    this.inputEl.addEventListener("input", () => this.onTyping());
  }

  public onTyping(): void {
    if (isLongMessage(this.inputEl.value)) this.hostEl.classList.add("surprise");
    else this.hostEl.classList.remove("surprise");
  }

  public onSend(bubbleEl?: HTMLElement | null): void {
    const bubble =
      bubbleEl ??
      (this.messagesEl.querySelector(".msg.user:last-of-type") as HTMLElement | null);
    if (!bubble) {
      this.triggerLean();
      return;
    }
    const long = isLongMessage(bubble.textContent ?? "");
    void this.escort(bubble, long ? "surprise" : "nod");
  }

  public onStepStart(stepCardEl?: HTMLElement | null): void {
    const card =
      stepCardEl ??
      (this.messagesEl.querySelector("details.run-steps:last-of-type") as HTMLElement | null);
    if (!card) return;
    void this.escort(card, "walk");
  }

  public onStepDone(): void {
    if (this.reduced) return;
    this.hostEl.classList.add("nod");
    this.later(700, () => this.hostEl.classList.remove("nod"));
  }

  public onTakeover(isUserControl: boolean): void {
    if (isUserControl) this.hostEl.classList.add("surprise");
    else {
      this.hostEl.classList.remove("surprise");
      if (!this.reduced) this.hostEl.classList.add("nod");
      this.later(700, () => this.hostEl.classList.remove("nod"));
    }
  }

  public onRunFinish(): void {
    const token = this.bump();
    if (!this.reduced) this.hostEl.classList.add("rebounding");
    this.later(this.reduced ? 200 : 900, () => {
      if (!this.alive(token)) return;
      this.hostEl.classList.remove("rebounding");
      this.resetToComposer();
    });
  }

  private async escort(target: HTMLElement, mood: "surprise" | "nod" | "walk"): Promise<void> {
    const token = this.bump();
    this.isVisiting = true;
    this.visitTarget = target;
    if (mood === "surprise" && !this.reduced) {
      this.hostEl.classList.add("surprise");
      await this.wait(720);
      if (!this.alive(token)) return;
      this.hostEl.classList.remove("surprise");
    } else if (mood === "nod" && !this.reduced) {
      this.hostEl.classList.add("nod");
      await this.wait(400);
      if (!this.alive(token)) return;
      this.hostEl.classList.remove("nod");
    } else {
      await this.anticipate(token);
    }
    if (!this.alive(token)) return;
    await this.alongTop(target, 0.12, 0.72, token);
    this.later(this.reduced ? 400 : 8000, () => {
      if (this.visitTarget === target) this.resetToComposer();
    });
  }

  private placeOnVisitTarget(): void {
    const target = this.visitTarget;
    if (!target || !this.appEl.contains(target)) {
      this.resetToComposer();
      return;
    }
    const msgRect = this.messagesEl.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    const visible = tRect.bottom > msgRect.top + 8 && tRect.top < msgRect.bottom - 8;
    if (!visible) {
      this.resetToComposer();
      return;
    }
    this.put(this.topPos(target, 0.35));
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.fidget().then(() => this.scheduleIdle());
    }, 4200 + Math.random() * 3200);
  }

  private async fidget(): Promise<void> {
    if (this.reduced || this.isPressing || this.isVisiting) return;
    const token = this.seq;
    const pool = ["rest", "rest", "look", "look", "hop", "peek", "wander"];
    let pick = pool[Math.floor(Math.random() * pool.length)] ?? "rest";
    if (pick === this.lastFidget) pick = "rest";
    this.lastFidget = pick;
    if (pick === "look") {
      this.hostEl.style.transform = "rotate(-12deg)";
      await this.wait(480);
      if (!this.alive(token)) return;
      this.hostEl.style.transform = "rotate(10deg)";
      await this.wait(480);
      if (!this.alive(token)) return;
      this.hostEl.style.transform = "none";
    } else if (pick === "hop") {
      this.hostEl.classList.add("rebounding");
      await this.wait(640);
      this.hostEl.classList.remove("rebounding");
    } else if (pick === "peek") {
      await this.animateTo(this.topPos(this.composerEl, 0), token, 500, -11);
      await this.wait(520);
      if (this.alive(token) && !this.isVisiting) this.resetToComposer();
    } else if (pick === "wander") {
      await this.alongTop(this.composerEl, 0.12, 0.55, token);
      if (this.alive(token) && !this.isVisiting) {
        await this.alongTop(this.composerEl, 0.55, 0.18, token);
      }
    }
  }

  public destroy(): void {
    this.clearTimers();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.messagesEl.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.hostEl.remove();
  }
}

export function mountCompanion(options: CompanionOptions): SideCompanion {
  return new SideCompanion(options);
}
