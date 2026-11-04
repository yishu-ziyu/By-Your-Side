import { D_EMPH } from "../shared/motion-tokens.js";
import { reducedMotion } from "./branch-graph.js";

type MotionIconKind =
  | "audio-lines"
  | "mic"
  | "camera"
  | "book-open"
  | "search"
  | "sliders-horizontal"
  | "download"
  | "undo-2"
  | "external-link";

const timers = new WeakMap<HTMLElement, number>();

function preparePaths(root: HTMLElement): void {
  for (const path of root.querySelectorAll<SVGPathElement>("svg path")) path.setAttribute("pathLength", "1");
}

export function setMotionIcon(el: HTMLElement, kind: MotionIconKind | null): void {
  if (kind) el.dataset.motionIcon = kind;
  else delete el.dataset.motionIcon;
  preparePaths(el);
}

function pulseMotionIcon(el: HTMLElement): void {
  if (reducedMotion() || !el.dataset.motionIcon) return;
  window.clearTimeout(timers.get(el));
  el.classList.remove("motion-icon-pulse");
  void el.offsetWidth;
  el.classList.add("motion-icon-pulse");
  timers.set(el, window.setTimeout(() => el.classList.remove("motion-icon-pulse"), D_EMPH));
}

export function setMotionActive(el: HTMLElement, active: boolean): void {
  if (active) el.dataset.motionActive = "true";
  else delete el.dataset.motionActive;
}

export function bindMotionIcon(el: HTMLElement, kind: MotionIconKind): void {
  setMotionIcon(el, kind);
  if (el.dataset.motionIconBound === "true") return;
  el.dataset.motionIconBound = "true";
  el.addEventListener("pointerenter", () => pulseMotionIcon(el));
  el.addEventListener("focusin", () => pulseMotionIcon(el));
  el.addEventListener("pointerdown", () => pulseMotionIcon(el));
}
