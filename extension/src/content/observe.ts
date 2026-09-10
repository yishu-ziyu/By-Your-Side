/**
 * 被动观察 content script（按需注入，幂等）。
 *
 * 只在用户打开"观察"开关、且不是敏感站点时运行。它记的是**骨架**：
 * 点了什么对象（语义锚点）、同一站点、一连串短时间内的动作算一次 run。
 * 不记输入值、不记页面文字、不录屏。
 *
 * 屏幕上没有它的任何痕迹：不加浮层、不改页面。
 */
import { scrubUrl, type DemoAnchor } from "../../../shared/demo-record.js";
import { anchorOfTarget, insideOverlay } from "../shared/dom-anchor.js";

interface ObserveApi {
  start(): { ok: true };
  stop(): { ok: true };
  active(): boolean;
}

(function () {
  const existing = (window.__sideagent as unknown as { observe?: ObserveApi } | undefined)?.observe;
  if (existing) return;
  const store = (window.__sideagent ??= {}) as unknown as { observe?: ObserveApi };

  /** 一次 run 的边界：同一站点、间隔不超过这个时间。 */
  const RUN_GAP_MS = 30_000;
  const MIN_STEPS = 2;

  let running = false;
  let anchors: DemoAnchor[] = [];
  let lastAt = 0;
  let tainted = false;

  function host(): string {
    try { return new URL(scrubUrl(location.href)?.replace(/\?…$/, "") ?? location.href).hostname; }
    catch { return location.hostname; }
  }

  function flush(): void {
    const hostname = host();
    const steps = anchors;
    const bad = tainted;
    anchors = [];
    tainted = false;
    if (bad || steps.length < MIN_STEPS) return;
    try {
      void chrome.runtime.sendMessage({ type: "sideagent:observed-run", run: { hostname, anchors: steps, at: Date.now() } });
    } catch {
      /* 通道不在就丢掉这一段：观察失败不能影响用户 */
    }
  }

  function onClick(ev: MouseEvent): void {
    if (!running || ev.button !== 0 || insideOverlay(ev.target)) return;
    const hit = anchorOfTarget(ev.target);
    if (!hit) return;
    // 碰到敏感字段：这一段整个丢掉，不留半个骨架
    if (hit.sensitive) { tainted = true; anchors = []; return; }
    const now = Date.now();
    if (now - lastAt > RUN_GAP_MS) { flush(); }
    lastAt = now;
    if (hit.anchor.name || hit.anchor.role) anchors.push(hit.anchor);
  }

  function onHidden(): void { if (document.visibilityState === "hidden") flush(); }

  function attach(on: boolean): void {
    const fn = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    fn("click", onClick as EventListener, true);
    fn("visibilitychange", onHidden);
    if (on) window.addEventListener("pagehide", flush);
    else window.removeEventListener("pagehide", flush);
  }

  store.observe = {
    start() {
      if (running) return { ok: true };
      running = true;
      anchors = [];
      tainted = false;
      lastAt = 0;
      attach(true);
      return { ok: true };
    },
    stop() {
      if (!running) return { ok: true };
      flush();
      running = false;
      attach(false);
      return { ok: true };
    },
    active() { return running; },
  };
})();
