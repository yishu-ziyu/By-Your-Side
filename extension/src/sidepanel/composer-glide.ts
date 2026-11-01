/**
 * 空会话里输入框和问候居中成组；发出第一句后布局切回「输入框在底边」。
 * 这一步只是换了一组 CSS 规则，浏览器会在一帧内把输入框瞬移过去，所以这里补一段 FLIP：
 * 记住上一帧输入框的位置，布局变化后从旧位置滑到新位置，问候原地淡出。
 *
 * 旧位置必须是「上一次画出来的」位置：观察回调里 DOM 已经变了，那时再量拿到的是新布局。
 */
import { reducedMotion } from "./branch-graph.js";

// 按底边比较：贴底时输入框长高、变矮只动顶边，不算移动，不做滑动。
const MIN_MOVE_PX = 2;

/** 动画正在加的位移；布局位置 = 量到的位置 - 这段位移。 */
function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
}

export function mountComposerGlide(app: HTMLElement, dock: HTMLElement, starter: HTMLElement, watch: HTMLElement[]): void {
  let lastBottom = dock.getBoundingClientRect().bottom;
  let lastStarter: DOMRect | null = null;
  let glide: Animation | null = null;
  // 打开侧栏时历史恢复完才排好版（starter-ready）：这一下直接到位，否则刚打开输入框就在滑，点上去会落空。
  let armed = false;
  const arm = () => { if (!armed && app.classList.contains("starter-ready")) requestAnimationFrame(() => requestAnimationFrame(() => { armed = true; remember(); })); };

  const starterShown = () => getComputedStyle(starter).display !== "none";

  const remember = () => {
    if (glide) return;
    lastBottom = dock.getBoundingClientRect().bottom;
    if (!app.classList.contains("starter-leaving")) lastStarter = starterShown() ? starter.getBoundingClientRect() : null;
  };

  const settle = () => {
    const shift = translateY(dock);
    const bottom = dock.getBoundingClientRect().bottom - shift;
    // 上一帧画出来的位置；滑到一半又变了布局（先出「正在发送」再切到底边）时从半路接着滑，不重新跳。
    const from = lastBottom + shift - bottom;
    const leaving = lastStarter && !starterShown() && !app.classList.contains("starter-leaving") ? lastStarter : null;

    if (!armed) { arm(); remember(); return; }

    if (Math.abs(bottom - lastBottom) < MIN_MOVE_PX) { if (!glide) remember(); return; }

    glide?.cancel();
    glide = null;
    lastBottom = bottom;

    if (reducedMotion()) { remember(); return; }

    const style = getComputedStyle(app);
    const duration = parseFloat(style.getPropertyValue("--m-morph")) || 420;
    const easing = style.getPropertyValue("--e-sweep").trim() || "ease-in-out";
    const current = dock.animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }], { duration, easing });
    glide = current;

    if (leaving) {
      // 问候已被 CSS 收起：按它上一帧的位置临时摆回去，只做淡出，不占布局。
      const appTop = app.getBoundingClientRect().top;
      starter.style.setProperty("--starter-leaving-top", `${leaving.top - appTop}px`);
      starter.style.setProperty("--starter-leaving-height", `${leaving.height}px`);
      app.classList.add("starter-leaving");
      const fade = starter.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-12px)" }], { duration: duration * 0.6, easing, fill: "forwards" });
      // 淡完先撤掉临时摆位再取消动画，否则下次回到空会话时问候还停在透明。
      void fade.finished.finally(() => { app.classList.remove("starter-leaving"); fade.cancel(); lastStarter = null; });
    }

    current.finished.then(() => { if (glide === current) { glide = null; remember(); } }, () => {});
  };

  const observer = new MutationObserver(settle);
  for (const el of watch) observer.observe(el, { attributes: true, attributeFilter: ["class", "hidden"], childList: true, subtree: el.id === "messages" });
  new ResizeObserver(remember).observe(dock);
  new ResizeObserver(remember).observe(app);
  arm();
}
