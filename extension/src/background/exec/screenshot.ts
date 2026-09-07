import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { sendCommand } from "../debugger.js";
import { maybeActivateTab, resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";

export interface ScreenshotResult {
  imageBase64: string;
  mediaType: "image/png";
  /** 图像像素宽/高（PNG 解码实测，恒大于 0；解码失败则整个调用明确失败）。点击用的 CSS 坐标见 cssWidth/cssHeight。 */
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  /** CSS 视口宽/高，即 click point 坐标系；查不到为 0。 */
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
}

/** PNG 解码失败即抛错：A1 要求像素尺寸真实正数，不允许 0 尺寸成功回包。 */
async function pngPixels(dataUrl: string): Promise<{ width: number; height: number }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    if (size.width <= 0 || size.height <= 0) throw new Error(`非法像素尺寸 ${size.width}x${size.height}`);
    return size;
  } catch (e) {
    throw new Error(`截图数据解码失败，拒绝返回无尺寸图片：${oneLine(e)}`);
  }
}

function parseViewport(w: unknown, h: unknown, dpr: unknown) {
  if (typeof w !== "number" || w <= 0 || typeof h !== "number" || h <= 0) return null;
  return {
    cssWidth: Math.round(w),
    cssHeight: Math.round(h),
    devicePixelRatio: typeof dpr === "number" && dpr > 0 ? dpr : 0,
  };
}

/**
 * CSS 视口/DPR：先走 CDP Runtime.evaluate；debugger 不可用时回退 chrome.scripting
 * 在页内读取（正常网页；chrome:// 等不支持页 executeScript 直接失败，走未知分支）。
 * 两条路都读不到才返回 0（未知），不写固定假值。
 */
async function queryViewport(
  tabId: number,
): Promise<{ cssWidth: number; cssHeight: number; devicePixelRatio: number }> {
  const unknown = { cssWidth: 0, cssHeight: 0, devicePixelRatio: 0 };
  try {
    const res = await sendCommand<{ result?: { value?: { w?: unknown; h?: unknown; dpr?: unknown } } }>(
      tabId,
      "Runtime.evaluate",
      {
        expression: "({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})",
        returnByValue: true,
      },
    );
    const v = res?.result?.value;
    const parsed = parseViewport(v?.w, v?.h, v?.dpr);
    if (parsed) return parsed;
  } catch {
    /* 走 scripting 回退 */
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        const g = globalThis as unknown as { innerWidth: number; innerHeight: number; devicePixelRatio: number };
        return { w: g.innerWidth, h: g.innerHeight, dpr: g.devicePixelRatio };
      },
    });
    const v = results[0]?.result as { w?: unknown; h?: unknown; dpr?: unknown } | undefined;
    const parsed = parseViewport(v?.w, v?.h, v?.dpr);
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

async function buildResult(opts: {
  tabId: number;
  dataUrl: string;
  source: ScreenshotResult["source"];
  preUrl: string;
  preViewport: { cssWidth: number; cssHeight: number; devicePixelRatio: number };
  /** visible-tab 回退需在捕获后再次确认工作页仍在前台；CDP 按 tab 捕获不受前台影响，只验 URL。 */
  verifyForeground: boolean;
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
  if (mismatch) {
    throw new Error(`截图期间视口变化（${mismatch}），图像素与 CSS 尺寸已对不上，已丢弃本次截图，请重拍。`);
  }
  return {
    imageBase64: opts.dataUrl.replace(/^data:image\/png;base64,/, ""),
    mediaType: "image/png",
    width: pixels.width,
    height: pixels.height,
    pixelWidth: pixels.width,
    pixelHeight: pixels.height,
    cssWidth: viewport.cssWidth,
    cssHeight: viewport.cssHeight,
    devicePixelRatio: viewport.devicePixelRatio,
    tabId: opts.tabId,
    url: post.url ?? "",
    title: post.title ?? "",
    capturedAt: Date.now(),
    source: opts.source,
  };
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
  _params: Record<string, never> = {},
  sessionId: string = LEAD_SESSION_ID,
): Promise<ScreenshotResult> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  // worker 透传 sessionId：maybeActivateTab 对非 Lead 直接返回，绝不抢用户前台。
  await maybeActivateTab(tab, sessionId);
  const pre = await chrome.tabs.get(tab.id);
  const preViewport = await queryViewport(tab.id);

  let dataUrl: string;
  let source: ScreenshotResult["source"];
  try {
    const captured = await sendCommand<{ data?: string }>(tab.id, "Page.captureScreenshot", { format: "png" });
    if (!captured.data) throw new Error("Page.captureScreenshot 返回空数据");
    dataUrl = `data:image/png;base64,${captured.data}`;
    source = "cdp";
  } catch (e) {
    // 只有 CDP 捕获本身失败才进回退；buildResult 的导航/切页丢弃错误不在此捕获，直接上抛。
    dataUrl = await visibleFallback(tab, e);
    source = "visible-tab";
  }
  return await buildResult({
    tabId: tab.id,
    dataUrl,
    source,
    preUrl: pre.url ?? "",
    preViewport,
    verifyForeground: source === "visible-tab",
  });
}
