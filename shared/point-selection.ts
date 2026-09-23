/** 用户指出的是哪个元素；这不是执行点击或其他页面写入的授权。 */
export const POINT_SELECTION_TIMEOUT_MS = 90_000;

export type PointSelection =
  | {
      status: "selected";
      element: {
        target: string;
        tagName: string;
        name: string;
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      };
    }
  | { status: "cancelled"; reason: "user" | "task_cancelled" | "page_changed" }
  | { status: "timed_out" };

export type PointSelectionReceipt = PointSelection & { tabId: number; documentId: string };
