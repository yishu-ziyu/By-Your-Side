import { OVERLAY_ATTR } from "../shared/overlay.js";
import {
  GUIDE_ARROW_CURVE_PX,
  GUIDE_DRAW_MS,
  GUIDE_ROUGHNESS,
  GUIDE_SPOTLIGHT_ALPHA,
  placeGuideBubble,
  sketchArrow,
  type Point2D,
  type RectBox,
} from "../shared/rough/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const NOTE_SELECTOR = "[data-sideagent-note], [data-sideagent-ask]";

const YIELD_ATTR = "data-bys-guide-yield";

const OBSTACLE_SELECTOR =
  "button,a,input,textarea,select,[role=button],[role=tab],[role=switch],[role=link],h1,h2,h3,[data-sideagent-note]";

export const GUIDE_CANVAS_STYLES = `
  :host {
    --guide-ink: #fbfcfe;
    --guide-fg: #111827;
    --guide-border: rgba(15, 23, 42, .11);
    --guide-shadow: 0 0 0 1px rgba(15, 23, 42, .08), 0 12px 28px -8px rgba(15, 23, 42, .14), 0 2px 6px rgba(15, 23, 42, .05);
    --guide-pen: #2d4a86;
    --guide-warn: #b74536;
    --guide-step-bg: #f1f4f9;
    --guide-spot-fill: rgb(15 23 42);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --guide-ink: #1b2332;
      --guide-fg: #e6ecf5;
      --guide-border: rgba(255, 255, 255, .14);
      --guide-shadow: 0 0 0 1px rgba(255, 255, 255, .1), 0 14px 32px -8px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .25);
      --guide-pen: #7aa2f7;
      --guide-warn: #eb9284;
      --guide-step-bg: #243044;
      --guide-spot-fill: rgb(0 0 0);
    }
  }
  .guide-spotlight {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 200ms cubic-bezier(.22, 1, .36, 1);
  }
  .guide-spotlight.on { opacity: 1; }
  .guide-spotlight-shade {
    fill: var(--guide-spot-fill);
    fill-opacity: ${GUIDE_SPOTLIGHT_ALPHA};
  }
  .mark.guidance {
    z-index: 2;
  }
  .mark.guidance .sketch-svg path.sketch-frame-path {
    stroke: var(--guide-pen);
    stroke-width: 2;
  }
  .mark.guidance.warn .sketch-svg path.sketch-frame-path,
  .mark.guidance.warn .sketch-svg path.sketch-arrow-path {
    stroke: var(--guide-warn);
  }
  .sketch-svg path.sketch-arrow-path {
    fill: none;
    stroke: var(--guide-pen);
    stroke-width: 2.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark.guidance .mark-label {
    box-sizing: border-box;
    width: max-content;
    max-width: min(320px, calc(100vw - 24px));
    white-space: normal;
    padding: 8px 12px;
    border: 1px solid var(--guide-border);
    border-radius: 10px;
    background: var(--guide-ink);
    color: var(--guide-fg);
    box-shadow: var(--guide-shadow);
    font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif;
    letter-spacing: 0;
  }
  .mark.guidance .mark-label[data-step]::before {
    content: attr(data-step);
    display: inline-block;
    margin-right: 7px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--guide-step-bg);
    color: var(--guide-pen);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
    vertical-align: 1px;
  }
  .mark.guidance.warn .mark-label {
    border-color: var(--guide-warn);
    animation: guideNudge 320ms cubic-bezier(.22, 1, .36, 1);
  }
  .mark.guidance.warn .mark-label[data-step]::before {
    color: var(--guide-warn);
  }
  @keyframes guideStrokeDraw {
    to { stroke-dashoffset: 0; }
  }
  @keyframes guideNudge {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-5px); }
    65% { transform: translateX(4px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .guide-spotlight { transition: none; }
    .mark.guidance.warn .mark-label { animation: none; }
  }
`;

export interface GuideRenderInput {
  markEl: HTMLDivElement;
  labelEl: HTMLElement;
  targetFrame: RectBox;
  targetEl: Element | null;
  seed: number;
  animate: boolean;
  warn: boolean;
  step?: number;
  cursorPoint?: Point2D;
}

export interface GuideCanvas {
  showSpotlight(rect: { x: number; y: number; width: number; height: number } | null): void;
  clearSpotlight(): void;
  syncStrokeDraw(svg: SVGElement, animate: boolean): void;
  renderGuideOverlay(input: GuideRenderInput): void;
  destroy(): void;
}

function makeSvg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);

  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));

  return el;
}

function collectObstacles(targetEl: Element | null, originX: number, originY: number): RectBox[] {
  const out: RectBox[] = [];
  const nodes = document.querySelectorAll(OBSTACLE_SELECTOR);
  const limit = Math.min(nodes.length, 160);

  for (let i = 0; i < limit; i++) {
    const el = nodes[i]!;

    if (el === targetEl || (targetEl && (targetEl.contains(el) || el.contains(targetEl)))) continue;
    if (el.closest(`[${OVERLAY_ATTR}]`)) continue;
    const r = el.getBoundingClientRect();

    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < -40 || r.top > window.innerHeight + 40 || r.right < -40 || r.left > window.innerWidth + 40) continue;
    out.push({ x: r.left - originX, y: r.top - originY, w: r.width, h: r.height });
  }

  return out;
}

function setPageNotesYielding(yielding: boolean): void {
  const notes = document.querySelectorAll<HTMLElement>(NOTE_SELECTOR);

  for (const host of notes) {
    if (yielding) {
      if (!host.hasAttribute(YIELD_ATTR)) {
        host.setAttribute(YIELD_ATTR, host.style.opacity);
        host.style.transition = "opacity 180ms cubic-bezier(.22, 1, .36, 1)";
      }
      host.style.opacity = "0.34";
    } else if (host.hasAttribute(YIELD_ATTR)) {
      host.style.opacity = host.getAttribute(YIELD_ATTR) ?? "";
      host.removeAttribute(YIELD_ATTR);
    }
  }
}

export function createGuideCanvas(shadow: ShadowRoot, reducedMotion: MediaQueryList): GuideCanvas {
  const maskId = `bys-spot-${Math.random().toString(36).slice(2, 8)}`;
  const blurId = `bys-blur-${Math.random().toString(36).slice(2, 8)}`;
  let spotSvg: SVGSVGElement | null = null;
  let spotHole: SVGRectElement | null = null;

  function ensureSpotlight(): void {
    if (spotSvg) return;
    const svg = makeSvg("svg", { class: "guide-spotlight", "aria-hidden": "true" });
    const defs = makeSvg("defs", {});
    const filter = makeSvg("filter", { id: blurId, x: "-10%", y: "-10%", width: "120%", height: "120%" });
    filter.appendChild(makeSvg("feGaussianBlur", { stdDeviation: 2.5 }));
    const mask = makeSvg("mask", { id: maskId });
    mask.appendChild(makeSvg("rect", { x: 0, y: 0, width: "100%", height: "100%", fill: "white" }));
    const hole = makeSvg("rect", { x: 0, y: 0, width: 0, height: 0, rx: 12, fill: "black", filter: `url(#${blurId})` });
    mask.appendChild(hole);
    defs.append(filter, mask);
    const shade = makeSvg("rect", { class: "guide-spotlight-shade", x: 0, y: 0, width: "100%", height: "100%", mask: `url(#${maskId})` });
    svg.append(defs, shade);
    // WHY: Insert spotlight before marksLayer so marksLayer.childElementCount only counts marks and bubbles sit above the dim shade.
    shadow.insertBefore(svg, shadow.firstChild);
    spotSvg = svg;
    spotHole = hole;
  }

  function animatePath(path: SVGPathElement, animate: boolean, delayMs: number): void {
    let len = 0;

    try { len = Math.ceil(path.getTotalLength()); } catch { len = 0; }
    if (len <= 0) return;
    path.style.strokeDasharray = String(len);

    if (!animate || reducedMotion.matches) {
      path.style.animation = "none";
      path.style.strokeDashoffset = "0";

      return;
    }

    path.style.strokeDashoffset = String(len);
    path.style.animation = `guideStrokeDraw ${GUIDE_DRAW_MS}ms cubic-bezier(.16, 1, .3, 1) ${delayMs}ms forwards`;
  }

  return {
    showSpotlight(rect): void {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        this.clearSpotlight();

        return;
      }

      ensureSpotlight();
      spotHole!.setAttribute("x", String(Math.round(rect.x - 10)));
      spotHole!.setAttribute("y", String(Math.round(rect.y - 8)));
      spotHole!.setAttribute("width", String(Math.round(rect.width + 20)));
      spotHole!.setAttribute("height", String(Math.round(rect.height + 16)));
      spotSvg!.classList.add("on");
      setPageNotesYielding(true);
    },

    clearSpotlight(): void {
      spotSvg?.classList.remove("on");
      setPageNotesYielding(false);
    },

    syncStrokeDraw(svg, animate): void {
      const frames = svg.querySelectorAll<SVGPathElement>(".sketch-frame-path");

      for (const path of frames) animatePath(path, animate, 0);
    },

    renderGuideOverlay(input): void {
      const { markEl, labelEl, targetFrame, targetEl, seed, animate, warn, step, cursorPoint } = input;
      markEl.classList.toggle("warn", warn);

      if (step && step > 0) labelEl.setAttribute("data-step", `第 ${step} 步`);
      else labelEl.removeAttribute("data-step");

      labelEl.style.display = "";
      const originX = (parseFloat(markEl.style.left) || 0) - window.scrollX;
      const originY = (parseFloat(markEl.style.top) || 0) - window.scrollY;
      const measured = labelEl.getBoundingClientRect();
      const size = { w: Math.max(80, measured.width || 220), h: Math.max(32, measured.height || 40) };
      const viewport: RectBox = { x: -originX, y: -originY, w: window.innerWidth, h: window.innerHeight };
      const obstacles = collectObstacles(targetEl, originX, originY);
      const localCursor = cursorPoint ? { x: cursorPoint.x - originX, y: cursorPoint.y - originY } : undefined;
      const placed = placeGuideBubble(targetFrame, size, viewport, obstacles, { cursorPoint: localCursor });

      labelEl.style.left = `${placed.left}px`;
      labelEl.style.top = `${placed.top}px`;

      const svg = markEl.querySelector<SVGSVGElement>("svg.sketch-svg");

      if (!svg) return;
      svg.querySelectorAll(".sketch-arrow-path").forEach((node) => node.remove());
      const arrow = sketchArrow(placed.box, targetFrame, { seed, roughness: GUIDE_ROUGHNESS, curvePx: GUIDE_ARROW_CURVE_PX });

      if (!arrow) return;
      const shaft = makeSvg("path", { class: "sketch-arrow-path shaft", d: arrow.shaft });
      const head = makeSvg("path", { class: "sketch-arrow-path head", d: arrow.head });
      svg.append(shaft, head);
      animatePath(shaft, animate, 60);
      animatePath(head, animate, Math.round(GUIDE_DRAW_MS * 0.65));
    },

    destroy(): void {
      setPageNotesYielding(false);
      spotSvg?.remove();
      spotSvg = null;
      spotHole = null;
    },
  };
}
