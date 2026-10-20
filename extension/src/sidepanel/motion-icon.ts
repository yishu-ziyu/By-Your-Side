import { D_EMPH } from "../shared/motion-tokens.js";
import { reducedMotion } from "./branch-graph.js";

export type MotionIconKind =
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

/** 标记图标或它的交互行；动画由 styles.css 按 data-motion-icon 选择。 */
export function setMotionIcon(el: HTMLElement, kind: MotionIconKind | null): void {
  if (kind) el.dataset.motionIcon = kind;
  else delete el.dataset.motionIcon;
  preparePaths(el);
}

/** 只在当前交互里动一次。目标可以是包着图标的按钮，也可以是有伪元素图标的按钮。 */
export function pulseMotionIcon(el: HTMLElement): void {
  if (reducedMotion() || !el.dataset.motionIcon) return;
  window.clearTimeout(timers.get(el));
  el.classList.remove("motion-icon-pulse");
  void el.offsetWidth;
  el.classList.add("motion-icon-pulse");
  timers.set(el, window.setTimeout(() => el.classList.remove("motion-icon-pulse"), D_EMPH));
}

/** 持续状态：录音、语音进行中这类“还在发生”的动作。 */
export function setMotionActive(el: HTMLElement, active: boolean): void {
  if (active) el.dataset.motionActive = "true";
  else delete el.dataset.motionActive;
}

/** 给图标行绑定一次性的悬停、聚焦和按下反馈；重复调用不会叠监听。 */
export function bindMotionIcon(el: HTMLElement, kind: MotionIconKind): void {
  setMotionIcon(el, kind);
  if (el.dataset.motionIconBound === "true") return;
  el.dataset.motionIconBound = "true";
  el.addEventListener("pointerenter", () => pulseMotionIcon(el));
  el.addEventListener("focusin", () => pulseMotionIcon(el));
  el.addEventListener("pointerdown", () => pulseMotionIcon(el));
}
