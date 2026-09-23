import { POINT_SELECTION_TIMEOUT_MS, type PointSelectionReceipt } from "../../../../shared/point-selection.js";
import { isLeadSession, type ToolContract } from "../../../../shared/protocol.js";
import { maybeActivateTab, resolveWorkingTab } from "../state.js";
import { parseExecutionKey } from "../tab-bindings.js";

/** 将等待绑定到具体文档和控制轮次；停止/接管不会留下遮罩等待 90 秒。 */
export async function askUserToPoint(
  params: ToolContract["ask_user_to_point"]["params"],
  sessionId: string,
  assertCurrent: () => void = () => {},
): Promise<PointSelectionReceipt> {
  assertCurrent();

  if (!isLeadSession(parseExecutionKey(sessionId).sessionId)) throw new Error("请由主会话请求用户点选；后台成员不能占用点选层。");
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id === undefined) throw new Error("没有可供点选的工作页。");
  const tabId = tab.id;
  assertCurrent();
  await maybeActivateTab(tab, sessionId);
  assertCurrent();
  const [injected] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content-point.js"], world: "ISOLATED" });
  const documentId = injected?.documentId;

  if (!documentId) throw new Error("未取得点选页面的文档身份。");
  const target = { tabId, documentIds: [documentId] };
  const requestId = crypto.randomUUID();

  const cancel = () => chrome.scripting.executeScript({
    target, world: "ISOLATED", args: [requestId],
    func: (id: string) => { window.__sideagent?.point?.cancel(id); },
  }).catch(() => {});

  let interruption: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const monitor = setInterval(() => {
    if (interruption) return;

    try { assertCurrent(); }
    catch (error) { interruption = error; void cancel(); }
  }, 200);

  try {
    assertCurrent();

    const results = await Promise.race([
      chrome.scripting.executeScript({
        target, world: "ISOLATED", args: [requestId, params.message ?? "请点一下你指的元素", POINT_SELECTION_TIMEOUT_MS],
        func: (id: string, message: string, timeoutMs: number) => {
          const point = window.__sideagent?.point;

          if (!point) throw new Error("点选组件没有就绪。");

          return point.start(id, message, timeoutMs);
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("点选通道未返回结果，已停止等待。")), POINT_SELECTION_TIMEOUT_MS + 5000);
      }),
    ]);

    if (interruption) throw interruption;
    assertCurrent();
    const result = results[0]?.result;

    if (!result) throw new Error("点选页面已离开，未收到选择结果。");
    // 同 URL 刷新也必须拒绝，不能让原页的 CSS 指向新文档。
    await chrome.scripting.executeScript({ target, world: "ISOLATED", func: () => document.readyState });
    assertCurrent();

    return { ...result, tabId, documentId };
  } finally {
    clearInterval(monitor);
    clearTimeout(timer);
    await cancel();
  }
}
