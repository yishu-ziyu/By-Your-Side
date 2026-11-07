import { reducedMotion } from "./branch-graph.js";

const MIN_MOVE_PX = 2;

function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
}

export function mountComposerGlide(app: HTMLElement, dock: HTMLElement, starter: HTMLElement, watch: HTMLElement[]): void {
  let lastBottom = dock.getBoundingClientRect().bottom;
  let lastStarter: DOMRect | null = null;
  let glide: Animation | null = null;
  let armed = false;
  const viewport = () => `${innerWidth}x${innerHeight}`;
  let lastViewport = viewport();
  const arm = () => { if (!armed && app.classList.contains("starter-ready")) requestAnimationFrame(() => requestAnimationFrame(() => { armed = true; remember(); })); };

  const starterShown = () => getComputedStyle(starter).display !== "none";

  const remember = () => {
    lastViewport = viewport();
    if (glide) return;
    lastBottom = dock.getBoundingClientRect().bottom;
    if (!app.classList.contains("starter-leaving")) lastStarter = starterShown() ? starter.getBoundingClientRect() : null;
  };

  const settle = () => {
    // WHY: 确认按钮移动会让按下与松开落在不同元素上，吞掉用户的确认或取消。
    if (dock.querySelector("#confirm-dock:not([hidden])")) {
      glide?.cancel();
      glide = null;
      remember();
      return;
    }
    if (viewport() !== lastViewport) {
      glide?.cancel();
      glide = null;
      remember();

      return;
    }

    const shift = translateY(dock);
    const bottom = dock.getBoundingClientRect().bottom - shift;
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
      const appTop = app.getBoundingClientRect().top;
      starter.style.setProperty("--starter-leaving-top", `${leaving.top - appTop}px`);
      starter.style.setProperty("--starter-leaving-height", `${leaving.height}px`);
      app.classList.add("starter-leaving");
      const fade = starter.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-12px)" }], { duration: duration * 0.6, easing, fill: "forwards" });
      void fade.finished.finally(() => { app.classList.remove("starter-leaving"); fade.cancel(); lastStarter = null; });
    }

    current.finished.then(() => { if (glide === current) { glide = null; remember(); } }, () => {});
  };

  const observer = new MutationObserver(settle);
  for (const el of watch) observer.observe(el, { attributes: true, attributeFilter: ["class", "hidden"], childList: true, subtree: el.id === "messages" });
  const confirmation = dock.querySelector("#confirm-dock");
  if (confirmation) observer.observe(confirmation, { attributes: true, attributeFilter: ["hidden"], childList: true });
  new ResizeObserver(remember).observe(dock);
  new ResizeObserver(remember).observe(app);
  arm();
}
