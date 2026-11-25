import type { GuideStepSpec } from "../../../shared/page-phase2.js";
import { createGuideCanvas, GUIDE_CANVAS_STYLES, type GuideCanvas } from "./guide-canvas.js";

const GUIDE_HOST_ATTR = "data-sideagent-interactive-guide";

export class InteractiveGuideSession {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private markEl: HTMLDivElement | null = null;
  private labelEl: HTMLDivElement | null = null;
  private canvas: GuideCanvas | null = null;
  private steps: GuideStepSpec[] = [];
  private index = 0;
  private cleanupCurrent: (() => void) | null = null;

  start(steps: GuideStepSpec[]): boolean {
    this.stop();
    if (steps.length === 0) return false;

    const host = document.createElement("div");
    host.setAttribute(GUIDE_HOST_ATTR, "1");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = GUIDE_CANVAS_STYLES;
    const markEl = document.createElement("div");
    markEl.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    const labelEl = document.createElement("div");
    labelEl.className = "guide-bubble";
    labelEl.style.cssText = "position:fixed;padding:8px 12px;border-radius:10px;background:var(--guide-ink);color:var(--guide-fg);border:1px solid var(--guide-border);box-shadow:var(--guide-shadow);font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;pointer-events:none;z-index:3;";
    shadow.append(style, markEl, labelEl);
    document.documentElement.append(host);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.host = host;
    this.shadow = shadow;
    this.markEl = markEl;
    this.labelEl = labelEl;
    this.canvas = createGuideCanvas(shadow, reducedMotion);
    this.steps = steps;
    this.index = 0;
    window.addEventListener("keydown", this.handleKeydown, true);
    return this.showCurrent();
  }

  stop(): void {
    this.cleanupCurrent?.();
    this.cleanupCurrent = null;
    window.removeEventListener("keydown", this.handleKeydown, true);
    this.canvas?.destroy();
    this.canvas = null;
    this.shadow = null;
    this.markEl = null;
    this.labelEl = null;
    this.host?.remove();
    this.host = null;
    this.steps = [];
    this.index = 0;
  }

  get currentStepIndex(): number {
    return this.index;
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.stop();
  };

  private showCurrent(): boolean {
    this.cleanupCurrent?.();
    this.cleanupCurrent = null;

    const step = this.steps[this.index];
    if (!step || !this.canvas || !this.markEl || !this.labelEl || !this.shadow) {
      this.stop();
      return false;
    }

    const target = document.querySelector(step.selector);
    if (!target) {
      this.stop();
      return false;
    }

    target.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = target.getBoundingClientRect();
    this.labelEl.textContent = `${this.index + 1}/${this.steps.length} · ${step.instruction}`;
    this.canvas.showSpotlight({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    this.canvas.renderGuideOverlay({
      markEl: this.markEl,
      labelEl: this.labelEl,
      targetFrame: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      targetEl: target,
      seed: this.index + 1,
      animate: true,
      warn: false,
      step: this.index + 1,
    });

    const eventName = step.advanceOn ?? "click";
    const onAdvance = () => {
      this.index += 1;
      window.setTimeout(() => {
        this.showCurrent();
      }, 60);
    };
    target.addEventListener(eventName, onAdvance, { once: true, capture: true });
    this.cleanupCurrent = () => target.removeEventListener(eventName, onAdvance, { capture: true });
    return true;
  }
}
