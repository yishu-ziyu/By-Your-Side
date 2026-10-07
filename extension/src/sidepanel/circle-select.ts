/**
 * 圈出来问（YIS-88，样子见 docs/previews/circle-and-memory）：在当前网页上按住拖动画手绘圈，可以连圈几处。
 * 每圈一处：页面在圈旁标上编号 → 画圈层先藏起淡色底和提示 → 后台截当前视口 → 侧栏按圈的外框裁切，变成带编号的附件。
 * 圈留在页面上（随页面滚动）；去掉某张附件，页面上那一圈也去掉。Esc、换标签页、页面跳转退出圈画，已圈的保留。永不自动发送。
 */
import { isPageInteractionMessage, type PageInteractionMessage } from "../../../shared/protocol.js";

type CaptureReply = { ok: boolean; dataUrl?: string; title?: string; error?: string };

type CircleRect = Extract<PageInteractionMessage, { type: "CIRCLE_DRAWN" }>["rect"];

const GLOBAL_KEY = "__byYourSideCircle";

type PageCircles = { enter: (start: number) => void; exit: () => void; remove: (n: number) => void };

/**
 * 注入页面执行（会被序列化，不能引用本模块的任何东西）。第一次调用建好画圈层，之后再调用只重新进入圈画。
 * start 是下一圈的编号；为 1 时清掉页面上之前的圈。
 */
function circleInPage(globalKey: string, start: number): void {
  // SAFETY: 页面全局对象按字符串键取值；这个键只存放本模块写入的控制对象。
  const g = globalThis as typeof globalThis & Record<string, PageCircles | undefined>;

  if (g[globalKey]) { g[globalKey].enter(start);

    return; }

  const SVG = "http://www.w3.org/2000/svg";
  const host = document.createElement("div");
  host.setAttribute("data-sideagent-overlay", "circle");
  host.style.cssText = "all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
:host{all:initial}
svg{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
path{fill:none;stroke:#d2602a;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:.9}
.num{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#d2602a;color:#fff;text-align:center;pointer-events:none;
  font:600 12.5px/22px -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(20,20,19,.2);animation:pop .22s cubic-bezier(.3,1.5,.5,1) both}
.mode{display:none}
.on .mode{display:block}
.dim{position:fixed;inset:0;background:rgba(20,20,19,.05);pointer-events:none}
.catch{position:fixed;inset:0;cursor:crosshair;touch-action:none;user-select:none;-webkit-user-select:none}
.hud{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);gap:10px;align-items:center;padding:6px 14px;border-radius:999px;background:#fff;
  border:1px solid rgba(20,20,19,.08);box-shadow:0 2px 10px rgba(20,20,19,.08);color:#5f5e58;white-space:nowrap;pointer-events:none;
  font:400 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;animation:rise .2s ease both}
.on .hud{display:flex}
.hud b{color:#141413;font-weight:600}
kbd{font:11px -apple-system,BlinkMacSystemFont,sans-serif;color:#77756d;border:1px solid rgba(20,20,19,.12);border-radius:5px;padding:0 5px}
.shooting .dim,.shooting .hud{visibility:hidden}
@keyframes pop{from{transform:scale(0)}}
@keyframes rise{from{opacity:0;transform:translate(-50%,8px)}}
@media (prefers-reduced-motion: reduce){.num,.hud{animation:none}}
</style><div class="wrap"><svg></svg><div class="mode dim"></div><div class="mode catch" role="application" aria-label="圈出来问：按住拖动圈出想问的地方，Esc 退出"></div>
<div class="mode hud"><span><b>按住拖动</b>圈出想问的地方，可以圈好几处</span><kbd>Esc</kbd><span>退出</span></div></div>`;
  const wrap = root.querySelector<HTMLElement>(".wrap")!;
  const ink = root.querySelector<SVGSVGElement>("svg")!;
  const catcher = root.querySelector<HTMLElement>(".catch")!;
  const circles = new Map<number, Element[]>();
  let next = start;
  let live: { id: number; pts: Array<[number, number]>; path: SVGPathElement } | null = null;
  let busy = false;

  // 圈用文档坐标，随页面滚动；顺滑成二次曲线，像手画。
  const smooth = (pts: Array<[number, number]>) => {
    let d = `M${pts[0]![0]} ${pts[0]![1]}`;

    for (let i = 1; i < pts.length - 1; i++) d += ` Q${pts[i]![0]} ${pts[i]![1]} ${(pts[i]![0] + pts[i + 1]![0]) / 2} ${(pts[i]![1] + pts[i + 1]![1]) / 2}`;
    const last = pts[pts.length - 1]!;

    return `${d} L${last[0]} ${last[1]}`;
  };

  const point = (e: PointerEvent): [number, number] => [e.clientX + scrollX, e.clientY + scrollY];

  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

  function exit(): void {
    if (!wrap.classList.contains("on")) return;
    wrap.classList.remove("on");
    removeEventListener("keydown", onKey, true);
    void chrome.runtime.sendMessage({ type: "CIRCLE_EXIT" }).catch(() => undefined);
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { swallow(e); exit(); } };

  async function finish(pts: Array<[number, number]>, path: SVGPathElement): Promise<void> {
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };

    // 太小的一笔当作误点。
    if (box.right - box.left < 14 && box.bottom - box.top < 14) { path.remove();

      return; }

    const n = next++;
    const badge = document.createElement("div");
    badge.className = "num";
    badge.textContent = String(n);
    badge.style.left = `${box.left + 6}px`;
    badge.style.top = `${box.top + 6}px`;
    wrap.appendChild(badge);
    path.dataset.n = String(n);
    circles.set(n, [path, badge]);
    // 截图前藏起淡色底和提示（圈和编号留着，助手看得出圈的是哪），等两帧让画面真的变了。
    busy = true;
    wrap.classList.add("shooting");
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const pad = 12;
    const left = Math.max(0, box.left - scrollX - pad);
    const top = Math.max(0, box.top - scrollY - pad);
    const rect = { x: left, y: top, width: Math.min(innerWidth, box.right - scrollX + pad) - left, height: Math.min(innerHeight, box.bottom - scrollY + pad) - top, viewportWidth: innerWidth, viewportHeight: innerHeight };
    await chrome.runtime.sendMessage({ type: "CIRCLE_DRAWN", n, rect }).catch(() => undefined);
    wrap.classList.remove("shooting");
    busy = false;
  }

  catcher.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || busy) return;
    swallow(e);
    const path = document.createElementNS(SVG, "path");
    ink.appendChild(path);
    live = { id: e.pointerId, pts: [point(e)], path };
    catcher.setPointerCapture(e.pointerId);
  });
  catcher.addEventListener("pointermove", (e) => {
    if (!live || e.pointerId !== live.id) return;
    swallow(e);
    live.pts.push(point(e));
    live.path.setAttribute("d", smooth(live.pts));
  });

  const release = (e: PointerEvent) => {
    if (!live || e.pointerId !== live.id) return;
    swallow(e);
    const done = live;
    live = null;

    if (e.type === "pointercancel" || done.pts.length < 3) { done.path.remove();

      return; }

    void finish(done.pts, done.path);
  };

  catcher.addEventListener("pointerup", release);
  catcher.addEventListener("pointercancel", release);

  for (const type of ["click", "dblclick", "mousedown", "mouseup", "contextmenu", "auxclick"]) catcher.addEventListener(type, swallow);

  const remove = (n: number) => { for (const el of circles.get(n) ?? []) el.remove(); circles.delete(n); };

  const enter = (from: number) => {
    if (from === 1) for (const n of Array.from(circles.keys())) remove(n);
    next = from;
    wrap.classList.add("on");
    addEventListener("keydown", onKey, true);
  };

  g[globalKey] = { enter, exit, remove };
  addEventListener("pagehide", () => { exit(); host.remove(); delete g[globalKey]; });
  document.documentElement.append(host);
  enter(start);
}

function exitInPage(globalKey: string): void {
  // SAFETY: 同 circleInPage：这个键只存放本模块写入的控制对象。
  (globalThis as typeof globalThis & Record<string, PageCircles | undefined>)[globalKey]?.exit();
}

function removeInPage(globalKey: string, n: number): void {
  // SAFETY: 同 circleInPage：这个键只存放本模块写入的控制对象。
  (globalThis as typeof globalThis & Record<string, PageCircles | undefined>)[globalKey]?.remove(n);
}

let active: { tabId: number; stop: () => void } | null = null;

/** 最近一次画圈的标签页：去掉附件时到这里去掉那一圈。 */
let circleTabId: number | null = null;

export function isCircling(): boolean { return active !== null; }

/** 从侧栏退出圈画（Esc、再次进入等）。 */
export function exitCircling(): void { active?.stop(); }

/** 去掉第 n 圈（附件被去掉时）。页面已经换了就什么都不做。 */
export function removeCircle(n: number): void {
  if (circleTabId == null) return;
  void chrome.scripting.executeScript({ target: { tabId: circleTabId }, func: removeInPage, args: [GLOBAL_KEY, n] }).catch(() => undefined);
}

/**
 * 进入圈画。每圈好一处调用 onCircle（截好的 PNG dataURL、编号、页面标题）；退出时结束，不返回附件。
 * 页面不允许注入时抛出带中文原因的错误。
 */
export async function startCircling(start: number, onCircle: (dataUrl: string, n: number, title: string) => Promise<void>): Promise<void> {
  active?.stop();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id == null) throw new Error("未找到当前激活的标签页");
  const tabId = tab.id;

  const onMessage: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, sender, respond) => {
    if (sender.tab?.id !== tabId || !isPageInteractionMessage(message)) return;

    if (message.type === "CIRCLE_EXIT") { stop(false);

      return; }

    if (message.type !== "CIRCLE_DRAWN") return;
    void captureCircle(message.rect).then(dataUrl => onCircle(dataUrl, message.n, tab.title || "网页"))
      .then(() => respond({ ok: true }), () => respond({ ok: false }));

    return true;
  };

  const onActivated = (info: { tabId: number }) => { if (info.tabId !== tabId) stop(true); };

  const onUpdated = (id: number, change: { status?: string; url?: string }) => { if (id === tabId && (change.status === "loading" || change.url)) stop(false); };

  // 用户点完菜单焦点还在侧栏，这里的 Esc 也要能退出。
  const onPanelKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stop(true); } };

  function stop(inPage: boolean): void {
    if (active?.tabId !== tabId) return;
    active = null;
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    document.removeEventListener("keydown", onPanelKey, true);

    if (inPage) void chrome.scripting.executeScript({ target: { tabId }, func: exitInPage, args: [GLOBAL_KEY] }).catch(() => undefined);
  }

  active = { tabId, stop: () => stop(true) };
  circleTabId = tabId;
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  document.addEventListener("keydown", onPanelKey, true);

  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: circleInPage, args: [GLOBAL_KEY, start] });
  } catch (err) {
    stop(false);
    throw new Error(`这个页面不能圈（${err instanceof Error ? err.message : String(err)}）`);
  }
}

async function captureCircle(rect: CircleRect): Promise<string> {
  const shot = await new Promise<CaptureReply>((resolve) => {
    chrome.runtime.sendMessage({ type: "sidepanel_capture_tab" }, (response: CaptureReply | undefined) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response ?? { ok: false, error: "未收到响应" });
    });
  });

  if (!shot.ok || !shot.dataUrl) throw new Error(shot.error || "截取视口失败");

  return cropToRegion(shot.dataUrl, rect);
}

/** 截图是设备像素；按截图宽高与视口 CSS 宽高之比换算，同时覆盖 devicePixelRatio 和页面缩放。 */
async function cropToRegion(dataUrl: string, region: CircleRect): Promise<string> {
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
