import type { TaskReceipt } from "../../../shared/task-actions.js";

/** 普通接收回执不复述整条输入；拒绝和不确定结果仍直接展示。 */
export function receiptCopy(receipt: TaskReceipt, selectedConversationId: string): { summary: string; detail: string; collapsed: boolean } {
  const detail = `${receipt.targetTitle} · ${receipt.message}${receipt.text && !receipt.message.includes(receipt.text) ? `\n原话：${receipt.text}` : ""}`;
  const local = receipt.conversationId === selectedConversationId;
  if (local && receipt.status === "accepted" && receipt.action === "start") {
    return { summary: "任务已接收", detail, collapsed: true };
  }
  if (local && receipt.status === "accepted" && receipt.action === "steer") {
    const queued = receipt.message.includes("继续后生效");
    return { summary: queued ? "修改已保存，交还后生效" : "修改已送达当前任务", detail, collapsed: true };
  }
  return { summary: local ? receipt.message : `${receipt.targetTitle} · ${receipt.message}`, detail, collapsed: false };
}
