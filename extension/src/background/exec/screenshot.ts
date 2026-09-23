import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { OVERLAY_ATTR } from "../../shared/overlay.js";
import { holdAttach, releaseAttachHold, sendCommand } from "../debugger.js";
import { maybeActivateTab, resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { readCurrentDocument } from "./page-readiness.js";
import { withTimeout } from "../timeout.js";

export interface ScreenshotResult {
  imageBase64: string;
  mediaType: "image/png";
  /** 图像像素宽/高（PNG 解码实测，恒大于 0；解码失败则整个调用明确失败）。点击用的 CSS 坐标见 cssWidth/cssHeight。 */
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  /** 捕获区域的 CSS 宽高，可含小数；点击还需按 coordinates 换算原点与滚动。 */
  cssWidth: number;
  cssHeight: number;
  /** 查不到为 0。 */
  devicePixelRatio: number;
  tabId: number;
  url: string;
  title: string;
  capturedAt: number;
  /** cdp = 指定工作页直接捕获；visible-tab = 捕获前后均核对工作页在前台后的可见捕获。 */
  source: "cdp" | "visible-tab";
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  scale?: "css" | "raw";
  documentId?: string;
  /** Null when capture geometry is unknown (for example a restricted browser page). */
  coordinates?: ToolContract["screenshot"]["data"]["coordinates"];
}

/**
 * 截图幕帘：拍之前把产品自己画的一切（光标、标注、控制条）藏起来，拍完放下。
 * 不藏的话 agent 会在自己的截图里看到一个页面上并不存在的发光箭头，把它当页面元素去理解甚至去点。
 * 幕帘失败（页面禁止注入、导航换文档）绝不能弄失败截图本身。
 */
async function curtain(tabId: number, hidden: boolean): Promise<void> {
  try {
    const run = chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async (attr: string, mark: string, hide: boolean) => {
        const nodes = document.querySelectorAll(`[${attr}]`);

        for (const node of nodes) {
          const el = node as HTMLElement;

          if (hide) {
            if (!el.hasAttribute(mark)) {
              el.setAttribute(mark, el.style.visibility || "");
              el.style.visibility = "hidden";
            }
          } else if (el.hasAttribute(mark)) {
            el.style.visibility = el.getAttribute(mark) || "";
            el.removeAttribute(mark);
          }
        }

        // 合成器要到下一帧才用上新样式；不等这一帧会拍到幕帘生效前的画面。
        // 页面被 JS dialog 挡住时 rAF 永不回调——必须有超时。
        if (hide) {
          await Promise.race([
            new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            new Promise<void>((resolve) => setTimeout(resolve, 200)),
          ]);
        }
      },
      args: [OVERLAY_ATTR, "data-sideagent-curtain", hidden],
    });

    await Promise.race([
      run,
      new Promise<void>((resolve) => setTimeout(resolve, 800)),
    ]);
  } catch {
    /* 幕帘失败不能弄失败截图本身 */
  }
}

/** PNG 解码失败即抛错：A1 要求像素尺寸真实正数，不允许 0 尺寸成功回包。 */
async function decodePng(dataUrl: string): Promise<ImageBitmap> {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

async function pngPixels(dataUrl: string): Promise<{ width: number; height: number }> {
  try {
    const bmp = await decodePng(dataUrl);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();

    if (size.width <= 0 || size.height <= 0) throw new Error(`非法像素尺寸 ${size.width}x${size.height}`);

    return size;
  } catch (e) {
    throw new Error(`截图数据解码失败，拒绝返回无尺寸图片：${oneLine(e)}`);
  }
}

type CaptureRegion = { x: number; y: number; width: number; height: number };

/** Chromium may quantize a fractional clip before applying its scale. Capture
 * the integer enclosing region, then crop only those real captured pixels.
 * Never draw substitute content; unknown source geometry fails closed. */
async function cropFractionalRegion(dataUrl: string, captured: CaptureRegion, requested: CaptureRegion, density: number): Promise<string> {
  const bitmap = await decodePng(dataUrl);

  try {
    if (Math.abs(bitmap.width - captured.width * density) > 1 || Math.abs(bitmap.height - captured.height * density) > 1) {
      throw new Error("真实截图尺寸不匹配包围区域，无法安全裁切小数坐标");
    }

    const width = Math.round(requested.width * density), height = Math.round(requested.height * density);

    if (width < 1 || height < 1) throw new Error("截图区域缩放后不足一个像素，请增大区域或比例");
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");

    if (!context) throw new Error("截图裁切上下文不可用");
    context.drawImage(bitmap, (requested.x - captured.x) * density, (requested.y - captured.y) * density,
      requested.width * density, requested.height * density, 0, 0, width, height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let encoded = "";

    for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));

    return `data:image/png;base64,${btoa(encoded)}`;
  } finally {
    bitmap.close();
  }
}


interface ViewportMetrics {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

/** Runtime.evaluate / chrome.scripting 读回来的原始视口读数，字段全部未经校验。 */
interface RawViewportReading {
  w?: unknown;
  h?: unknown;
  dpr?: unknown;
  x?: unknown;
  y?: unknown;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 边界解析：CDP/scripting 读回的未知读数 → 具名视口指标；宽高任一非正数即未知。 */
function parseViewport(reading: RawViewportReading | undefined): ViewportMetrics | null {
  const { w, h, dpr, x = 0, y = 0 } = reading ?? {};

  if (!isPositiveNumber(w) || !isPositiveNumber(h)) return null;

  return {
    cssWidth: Math.round(w),
    cssHeight: Math.round(h),
    devicePixelRatio: isPositiveNumber(dpr) ? dpr : 0,
    scrollX: isFiniteNumber(x) ? x : 0,
    scrollY: isFiniteNumber(y) ? y : 0,
  };
}

/**
 * CSS 视口/DPR：先走 CDP Runtime.evaluate；debugger 不可用时回退 chrome.scripting
 * 在页内读取（正常网页；chrome:// 等不支持页 executeScript 直接失败，走未知分支）。
 * 两条路都读不到才返回 0（未知），不写固定假值。
 */
async function queryViewport(
  tabId: number,
): Promise<ViewportMetrics> {
  const unknown = { cssWidth: 0, cssHeight: 0, devicePixelRatio: 0, scrollX: 0, scrollY: 0 };

  try {
    const evalPromise = sendCommand<{ result?: { value?: { w?: unknown; h?: unknown; dpr?: unknown; x?: unknown; y?: unknown } } }>(
      tabId,
      "Runtime.evaluate",
      {
        expression: "({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, x: window.scrollX, y: window.scrollY})",
        returnByValue: true,
      },
      undefined,
      3000,
    );

    const res = await evalPromise;
    const v = res?.result?.value;
    const parsed = parseViewport(v);

    if (parsed) return parsed;
  } catch {
    /* 走 scripting 回退 */
  }

  try {
    const results = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, x: scrollX, y: scrollY };
      },
    }), 3000, "Screenshot viewport read timed out");

    const v = results[0]?.result as { w?: unknown; h?: unknown; dpr?: unknown; x?: unknown; y?: unknown } | undefined;
    const parsed = parseViewport(v);

    if (parsed) return parsed;
  } catch {
    /* 不支持页：保持未知 */
  }

  return unknown;
}

/** 捕获前后已知视口/DPR 不一致则返回差异描述；任一侧未知则无法判定，返回 null（不拦截）。 */
function viewportMismatch(
  pre: { cssWidth: number; cssHeight: number; devicePixelRatio: number },
  post: { cssWidth: number; cssHeight: number; devicePixelRatio: number },
): string | null {
  if (pre.cssWidth <= 0 || post.cssWidth <= 0 || pre.cssHeight <= 0 || post.cssHeight <= 0) return null;

  if (pre.cssWidth !== post.cssWidth || pre.cssHeight !== post.cssHeight) {
    return `CSS 视口 ${pre.cssWidth}x${pre.cssHeight} → ${post.cssWidth}x${post.cssHeight}`;
  }

  if (pre.devicePixelRatio > 0 && post.devicePixelRatio > 0 && pre.devicePixelRatio !== post.devicePixelRatio) {
    return `DPR ${pre.devicePixelRatio} → ${post.devicePixelRatio}`;
  }

  return null;
}

async function contentBox(tabId: number): Promise<{ width: number; height: number } | null> {
  try {
    const metrics = await sendCommand<{
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    }>(tabId, "Page.getLayoutMetrics", {}, undefined, 5000);

    const box = metrics.cssContentSize ?? metrics.contentSize;

    if (!box || typeof box.width !== "number" || typeof box.height !== "number") return null;

    if (box.width <= 0 || box.height <= 0) return null;

    return { width: box.width, height: box.height };
  } catch {
    return null;
  }
}

async function buildResult(opts: {
  tabId: number;
  dataUrl: string;
  source: ScreenshotResult["source"];
  preUrl: string;
  preViewport: { cssWidth: number; cssHeight: number; devicePixelRatio: number };
  /** visible-tab 回退需在捕获后再次确认工作页仍在前台；CDP 按 tab 捕获不受前台影响，只验 URL。 */
  verifyForeground: boolean;
  cssWidth: number;
  cssHeight: number;
  fullPage?: boolean;
  clip?: ScreenshotResult["clip"];
  scale?: "css" | "raw";
  documentId?: string;
  origin?: { x: number; y: number };
  scroll?: { x: number; y: number };
  density?: number;
}): Promise<ScreenshotResult> {
  const pixels = await pngPixels(opts.dataUrl);
  // 捕获后重读：URL 必须与捕获前一致，否则是旧图配新 URL，直接丢弃。
  const post = await chrome.tabs.get(opts.tabId);

  if ((post.url ?? "") !== (opts.preUrl ?? "")) {
    throw new Error(
      `截图期间页面发生导航（前 ${opts.preUrl || "(未知)"} → 后 ${post.url || "(未知)"}），已丢弃本次截图，请重拍。`,
    );
  }

  if (opts.verifyForeground) {
    const [active] = await chrome.tabs.query({ active: true, windowId: post.windowId });

    if (active?.id !== opts.tabId) {
      throw new Error(
        `截图后活动页已切走（工作页 tab=${opts.tabId}，同窗口活动页 tab=${active?.id ?? "无"}），已丢弃本次图片，请切回工作页再试。`,
      );
    }
  }

  const viewport = await queryViewport(opts.tabId);
  const mismatch = viewportMismatch(opts.preViewport, viewport);

  if (mismatch || (opts.scroll && (viewport.scrollX !== opts.scroll.x || viewport.scrollY !== opts.scroll.y))) {
    throw new Error(`截图期间视口变化（${mismatch ?? "滚动位置改变"}），已丢弃本次截图，请重拍。`);
  }

  // Last asynchronous check: a same-URL reload during the post-capture
  // viewport read must not return pixels labeled with the old document.
  const currentDocument = await readCurrentDocument(opts.tabId);

  if (opts.documentId && currentDocument?.documentId !== opts.documentId) {
    throw new Error("STALE_DOCUMENT: 截图期间文档被替换，已丢弃旧图，请重新观察。");
  }

  if (opts.density && (Math.abs(pixels.width - opts.cssWidth * opts.density) > 1 || Math.abs(pixels.height - opts.cssHeight * opts.density) > 1)) {
    throw new Error(`截图像素比例与捕获区域不符：${pixels.width}x${pixels.height}，不能按 ${opts.density} 像素/CSS 像素使用`);
  }

  const result: ScreenshotResult = {
    imageBase64: opts.dataUrl.replace(/^data:image\/png;base64,/, ""),
    mediaType: "image/png",
    width: pixels.width,
    height: pixels.height,
    pixelWidth: pixels.width,
    pixelHeight: pixels.height,
    cssWidth: opts.cssWidth > 0 ? opts.cssWidth : viewport.cssWidth,
    cssHeight: opts.cssHeight > 0 ? opts.cssHeight : viewport.cssHeight,
    devicePixelRatio: viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : opts.preViewport.devicePixelRatio,
    tabId: opts.tabId,
    url: post.url ?? "",
    title: post.title ?? "",
    capturedAt: Date.now(),
    source: opts.source,
    coordinates: opts.density && opts.origin && opts.scroll ? {
      origin: opts.origin, scroll: opts.scroll,
      viewport: { width: viewport.cssWidth, height: viewport.cssHeight },
      pixelsPerCssPixel: opts.density, space: "document",
    } : null,
  };

  // 可选字段：保留「未提供即不带这个键」的语义，不用 `...(cond ? {k} : {})` 掩盖省略。
  if (opts.fullPage) result.fullPage = true;

  if (opts.clip) result.clip = opts.clip;

  if (opts.scale) result.scale = opts.scale;

  if (opts.documentId) result.documentId = opts.documentId;

  return result;
}

/**
 * CDP 失败后的可见捕获回退：仅当工作页确为同窗口活动页才拍，
 * 否则明确失败——绝不返回另一页的图片、绝不谎称工作页截图，也不为截图抢前台。
 */
async function visibleFallback(tab: chrome.tabs.Tab, cdpError: unknown): Promise<string> {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });

  if (active?.id !== tab.id) {
    throw new Error(
      `工作页截图失败且工作页当前不在前台，已拒绝可见捕获回退（工作页 tab=${tab.id}，同窗口活动页 tab=${active?.id ?? "无"}），未返回其他页面图片。请先 switch_tab 到工作页或将其切到前台再试。CDP 错误：${oneLine(cdpError)}`,
    );
  }

  return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

export async function screenshot(
  params: {
    tabId?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
    scale?: "css" | "raw";
  } = {},
  sessionId: string = LEAD_SESSION_ID,
): Promise<ScreenshotResult> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  // worker 透传 sessionId：maybeActivateTab 对非 Lead 直接返回，绝不抢用户前台。
  await maybeActivateTab(tab, sessionId);
  const pre = await chrome.tabs.get(tab.id);
  const documentBefore = await readCurrentDocument(tab.id);

  if (params.scale !== undefined && params.scale !== "css" && params.scale !== "raw") throw new Error("INVALID_ARGUMENT: screenshot.scale must be css or raw");
  let scaleMode: "css" | "raw" = params.scale === "raw" ? "raw" : "css";

  let clip = params.clip;
  let fullPage = params.fullPage === true;

  if (clip) {
    if (
      !Number.isFinite(clip.x) ||
      !Number.isFinite(clip.y) ||
      !Number.isFinite(clip.width) ||
      !Number.isFinite(clip.height) ||
      clip.width <= 0 || clip.height <= 0 || clip.x < 0 || clip.y < 0 ||
      (clip.scale !== undefined && (!Number.isFinite(clip.scale) || clip.scale <= 0 || clip.scale > 4))
    ) {
      throw new Error("INVALID_ARGUMENT: screenshot.clip 需要有限正数 width/height 与有限 x/y（CSS 像素）");
    }

    fullPage = false;
  } else if (fullPage) {
    const box = await contentBox(tab.id);

    if (!box) throw new Error("无法读取全页内容尺寸，fullPage 截图未执行。");
    clip = { x: 0, y: 0, width: box.width, height: box.height };
  }

  const preViewport = await queryViewport(tab.id);
  const dpr = preViewport.devicePixelRatio;

  // Restricted pages may have no geometry. Preserve real raw capture, explicitly
  // dropping the CSS promise and coordinate conversion instead of guessing DPR.
  if (!dpr || !preViewport.cssWidth || !preViewport.cssHeight) {
    if (clip) throw new Error("截图区域/DPR 无法核对，局部或全页截图未执行。");
    scaleMode = "raw";
  }

  const region = clip ?? (preViewport.cssWidth && preViewport.cssHeight
    ? { x: preViewport.scrollX, y: preViewport.scrollY, width: preViewport.cssWidth, height: preViewport.cssHeight }
    : undefined);

  // Explicit clip.scale overrides css/raw; it is the CDP scale, not DPR.
  const clipScale =
    clip?.scale !== undefined
      ? clip.scale
      : scaleMode === "css"
        ? 1 / dpr
        : 1;

  const density = dpr > 0 ? dpr * clipScale : undefined;
  const fractional = region && [region.x, region.y, region.width, region.height].some(value => !Number.isInteger(value));

  const captureRegion = region && fractional ? {
    x: Math.floor(region.x), y: Math.floor(region.y),
    width: Math.ceil(region.x + region.width) - Math.floor(region.x),
    height: Math.ceil(region.y + region.height) - Math.floor(region.y),
  } : region;

  if (captureRegion && density && (captureRegion.width * captureRegion.height * density ** 2 > 100_000_000 || Math.max(captureRegion.width, captureRegion.height) * density > 32768)) {
    throw new Error("截图区域超过图像预算；请使用较小 clip，不返回截断或占位图。");
  }

  const cdpParams: Record<string, unknown> = { format: "png", fromSurface: true, optimizeForSpeed: true };

  if (captureRegion) {
    cdpParams.clip = {
      x: captureRegion.x,
      y: captureRegion.y,
      width: captureRegion.width,
      height: captureRegion.height,
      scale: clipScale,
    };
    cdpParams.captureBeyondViewport = true;
  }

  const cssWidth = clip ? clip.width : preViewport.cssWidth;
  const cssHeight = clip ? clip.height : preViewport.cssHeight;

  let dataUrl: string;
  let source: ScreenshotResult["source"];
  holdAttach(tab.id);

  try {
    await curtain(tab.id, true);

    try {
      const captured = await sendCommand<{ data?: string }>(tab.id, "Page.captureScreenshot", cdpParams, undefined, 10_000);

      if (!captured.data) throw new Error("Page.captureScreenshot 返回空数据");
      dataUrl = `data:image/png;base64,${captured.data}`;
      source = "cdp";

      if (fractional && captureRegion && region && density) dataUrl = await cropFractionalRegion(dataUrl, captureRegion, region, density);
    } catch (e) {
      if (clip || fullPage) throw new Error(`局部/全页截图失败（${oneLine(e)}）`);
      dataUrl = await visibleFallback(tab, e);
      source = "visible-tab";
      // captureVisibleTab is a raw capture. Do not label it CSS-scaled.
      scaleMode = "raw";
    } finally {
      // Restore overlays before the final identity check, not after validating
      // and constructing a reply for a document that may since have changed.
      await curtain(tab.id, false);
    }

    return await buildResult({
      tabId: tab.id, dataUrl, source, preUrl: pre.url ?? "", preViewport,
      verifyForeground: source === "visible-tab", cssWidth, cssHeight,
      fullPage: fullPage || undefined, clip: params.clip, scale: params.clip?.scale !== undefined ? undefined : scaleMode,
      documentId: documentBefore?.documentId,
      origin: region ? { x: region.x, y: region.y } : undefined,
      scroll: region ? { x: preViewport.scrollX, y: preViewport.scrollY } : undefined,
      density: source === "visible-tab" ? (dpr || undefined) : density,
    });
  } finally {
    releaseAttachHold(tab.id);
  }
}
