import { activateTab, resolveWorkingTab } from "../state.js";

export async function screenshot(): Promise<{
  imageBase64: string;
  mediaType: "image/png";
  width: number;
  height: number;
}> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  await activateTab(tab);

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const imageBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  // 尺寸量取失败不阻塞：返回 0x0
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
