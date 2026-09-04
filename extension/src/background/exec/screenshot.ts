import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { sendCommand } from "../debugger.js";
import { maybeActivateTab, resolveWorkingTab } from "../state.js";

export async function screenshot(
  _params: Record<string, never> = {},
  sessionId: string = LEAD_SESSION_ID,
): Promise<{
  imageBase64: string;
  mediaType: "image/png";
  width: number;
  height: number;
}> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  await maybeActivateTab(tab, sessionId);

  try {
    const captured = await sendCommand<{ data?: string }>(tab.id, "Page.captureScreenshot", { format: "png" });
    if (captured.data) {
      return { imageBase64: captured.data, mediaType: "image/png", width: 0, height: 0 };
    }
  } catch {
    /* 后台标签 CDP 失败时再走可见捕获（可能拍到别的前台页） */
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const imageBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  let width = 0;
  let height = 0;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    width = bmp.width;
    height = bmp.height;
    bmp.close();
  } catch {
    /* 尺寸不可得，忽略 */
  }

  return { imageBase64, mediaType: "image/png", width, height };
}
