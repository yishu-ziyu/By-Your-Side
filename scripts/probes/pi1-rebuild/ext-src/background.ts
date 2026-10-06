/** Service worker：建、关 offscreen 文档。驱动脚本经 CDP 调 globalThis.offscreen.*。 */
const url = "page.html";

Object.assign(globalThis, { offscreen: {
  create: () => chrome.offscreen.createDocument({ url, reasons: [chrome.offscreen.Reason.WORKERS], justification: "pi1-rebuild probe: agent loop" }),
  close: () => chrome.offscreen.closeDocument(),
  has: () => chrome.offscreen.hasDocument(),
} });
