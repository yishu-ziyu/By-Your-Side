/**
 * #50 从屏幕选取：在当前网页上拖一个框，框内截图变成输入框附件。
 * 流程：向当前标签页注入一次性选区层（封闭 shadow，吃掉指针事件）→ 用户拖框松手 → 层先卸掉 →
 * 后台截当前视口（sidepanel_capture_tab）→ 侧栏按「截图像素 / 视口 CSS 像素」比例裁切。
 * Esc、×、切换标签页、页面跳转或隐藏都会取消，取消不留附件。永不自动发送。
 */

export interface PageRegion { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }

type CaptureReply = { ok: boolean; dataUrl?: string; title?: string; error?: string };

const GLOBAL_KEY = "__byYourSideRegionSelect";

/**
 * 注入页面执行（会被序列化，不能引用本模块的任何东西）。
 * 结果：选好的视口矩形（CSS 像素），取消返回 null。返回前选区层已从页面移除并等过两帧，截图里不会带上它。
 */
function pickRegionInPage(globalKey: string): Promise<PageRegion | null> {
  // SAFETY: 页面全局对象按字符串键取值；这个键只存放本模块写入的取消函数，其余键不读。
  const g = globalThis as typeof globalThis & Record<string, ((reason?: string) => void) | undefined>;
  g[globalKey]?.("replaced");

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-sideagent-overlay", "region-select");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
:host{all:initial}
.layer{position:fixed;inset:0;cursor:crosshair;background:rgba(0,0,0,.38);touch-action:none;user-select:none;-webkit-user-select:none;
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
.layer.dragging{background:transparent}
.sel{position:fixed;display:none;border:1.5px solid #fff;border-radius:2px;box-shadow:0 0 0 100vmax rgba(0,0,0,.38),0 0 0 1px rgba(0,0,0,.35) inset;pointer-events:none}
.layer.dragging .sel{display:block}
.hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;border-radius:99px;
  background:rgba(20,20,19,.88);color:#fff;border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.28);cursor:default;white-space:nowrap}
.layer.dragging .hint{display:none}
button{all:unset;box-sizing:border-box;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;cursor:pointer;background:rgba(255,255,255,.16);color:#fff;font-size:14px;line-height:1}
button:hover{background:rgba(255,255,255,.28)}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
</style><div class="layer" role="dialog" aria-label="从屏幕选取"><div class="sel"></div><div class="hint"><span>拖动框选要问的区域 · Esc 取消</span><button type="button" aria-label="取消选取" title="取消">×</button></div></div>`;
    const layer = root.querySelector<HTMLElement>(".layer")!;
    const sel = root.querySelector<HTMLElement>(".sel")!;
    const hint = root.querySelector<HTMLElement>(".hint")!;
    const closeBtn = root.querySelector<HTMLButtonElement>("button")!;
    let start: { x: number; y: number; id: number } | null = null;
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let done = false;

    const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { swallow(e); finish(null); } };

    const onHidden = () => { if (document.visibilityState === "hidden") finish(null); };

    const onPageHide = () => finish(null);
    const observer = new MutationObserver(() => { if (!host.isConnected) finish(null); });

    function finish(region: PageRegion | null): void {
      if (done) return;
      done = true;
      observer.disconnect();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);

      if (g[globalKey] === cancel) delete g[globalKey];

      host.remove();

      if (!region) { resolve(null);

        return; }

      // 等两帧让选区层从画面上真正消失，再交给截图。
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(region)));
    }

    const cancel = () => finish(null);
    g[globalKey] = cancel;

    const draw = (x: number, y: number) => {
      if (!start) return;
      const left = Math.max(0, Math.min(start.x, x));
      const top = Math.max(0, Math.min(start.y, y));
      const right = Math.min(window.innerWidth, Math.max(start.x, x));
      const bottom = Math.min(window.innerHeight, Math.max(start.y, y));
      rect = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      sel.style.left = `${rect.x}px`; sel.style.top = `${rect.y}px`;
      sel.style.width = `${rect.width}px`; sel.style.height = `${rect.height}px`;
    };

    closeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => { swallow(e); finish(null); });
    layer.addEventListener("pointerdown", (e) => {
      // SAFETY: 指针事件的 composedPath 首项是命中的 DOM 节点。
      if (e.button !== 0 || hint.contains(e.composedPath()[0] as Node)) return;
      swallow(e);
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      layer.setPointerCapture(e.pointerId);
      layer.classList.add("dragging");
      draw(e.clientX, e.clientY);
    });
    layer.addEventListener("pointermove", (e) => { if (start && e.pointerId === start.id) { swallow(e); draw(e.clientX, e.clientY); } });

    const release = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      swallow(e);
      draw(e.clientX, e.clientY);
      start = null;
      layer.classList.remove("dragging");

      // 太小的框当作误点：留在选取状态让用户重拖。
      if (rect.width < 6 || rect.height < 6 || e.type === "pointercancel") return;
      finish({ ...rect, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    };

    layer.addEventListener("pointerup", release);
    layer.addEventListener("pointercancel", release);

    for (const type of ["click", "dblclick", "mousedown", "mouseup", "contextmenu", "auxclick"]) layer.addEventListener(type, swallow);
    // 视口不动，框选坐标才和截图对得上。
    layer.addEventListener("wheel", swallow, { passive: false });

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    document.documentElement.append(host);
    observer.observe(document.documentElement, { childList: true });
  });
}

function cancelInPage(globalKey: string): void {
  // SAFETY: 页面全局对象按字符串键取值；这个键只存放本模块写入的取消函数，其余键不读。
  const g = globalThis as typeof globalThis & Record<string, ((reason?: string) => void) | undefined>;
  g[globalKey]?.("cancel");
}

let active: { tabId: number; cancel: () => void } | null = null;

/** 选取进行中时从侧栏取消（Esc、再次点菜单等）。 */
export function cancelRegionSelect(): void { active?.cancel(); }

export function isRegionSelectActive(): boolean { return active !== null; }

/**
 * 让用户在当前标签页拖框，返回框内截图（PNG dataURL）和页面标题；取消返回 null。
 * 页面不允许注入或截图时抛出带中文原因的错误。
 */
export async function selectRegionFromScreen(): Promise<{ dataUrl: string; title: string } | null> {
  active?.cancel();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id == null) throw new Error("未找到当前激活的标签页");
  const tabId = tab.id;

  const region = await new Promise<PageRegion | null>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      document.removeEventListener("keydown", onPanelKey, true);

      if (active?.tabId === tabId) active = null;
      fn();
    };

    const cancel = () => {
      void chrome.scripting.executeScript({ target: { tabId }, func: cancelInPage, args: [GLOBAL_KEY] }).catch(() => {});
      settle(() => resolve(null));
    };

    const onActivated = (info: { tabId: number }) => { if (info.tabId !== tabId) cancel(); };

    const onUpdated = (id: number, change: { status?: string; url?: string }) => { if (id === tabId && (change.status === "loading" || change.url)) cancel(); };

    const onRemoved = (id: number) => { if (id === tabId) settle(() => resolve(null)); };

    // 用户点完菜单焦点还在侧栏，这里的 Esc 也要能取消。
    const onPanelKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } };

    active = { tabId, cancel };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    document.addEventListener("keydown", onPanelKey, true);

    // SAFETY: pickRegionInPage 只返回 PageRegion 或 null，与注入函数的返回类型一致。
    chrome.scripting.executeScript({ target: { tabId }, func: pickRegionInPage, args: [GLOBAL_KEY] })
      .then((results) => settle(() => resolve((results[0]?.result as PageRegion | null | undefined) ?? null)))
      .catch((err) => settle(() => reject(new Error(`这个页面不允许选取（${err instanceof Error ? err.message : String(err)}）`))));
  });

  if (!region) return null;

  const shot = await new Promise<CaptureReply>((resolve) => {
    chrome.runtime.sendMessage({ type: "sidepanel_capture_tab" }, (response: CaptureReply | undefined) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response ?? { ok: false, error: "未收到响应" });
    });
  });

  if (!shot.ok || !shot.dataUrl) throw new Error(shot.error || "截取视口失败");

  return { dataUrl: await cropToRegion(shot.dataUrl, region), title: shot.title || tab.title || "网页" };
}

/** 截图是设备像素；按截图宽高与视口 CSS 宽高之比换算，同时覆盖 devicePixelRatio 和页面缩放。 */
async function cropToRegion(dataUrl: string, region: PageRegion): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("截图解码失败"));
    img.src = dataUrl;
  });
  const sx = img.naturalWidth / region.viewportWidth;
  const sy = img.naturalHeight / region.viewportHeight;
  const left = Math.max(0, Math.round(region.x * sx));
  const top = Math.max(0, Math.round(region.y * sy));
  const width = Math.max(1, Math.min(img.naturalWidth - left, Math.round(region.width * sx)));
  const height = Math.max(1, Math.min(img.naturalHeight - top, Math.round(region.height * sy)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (!ctx) throw new Error("无法裁切截图");
  ctx.drawImage(img, left, top, width, height, 0, 0, width, height);

  return canvas.toDataURL("image/png");
}
