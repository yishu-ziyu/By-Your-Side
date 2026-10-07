import type { TaskReceipt, TaskReceiptDiff } from "../../../shared/task-actions.js";

/** Host-verified field changes render as 旧值→新值; preserved only what was read back unchanged. */
function diffLine(diff: TaskReceiptDiff): string {
  const changed = diff.changed.map((change) => `${change.attribute}：${change.from} → ${change.to}`).join("；");
  const preserved = diff.preserved.length ? `；${diff.preserved.join("、")}保持不变` : "";

  return `${diff.target}：${changed}${preserved}`;
}

/** 侧栏回执的展示文案；inProcess 表示归入执行过程记录。 */
export type ReceiptCopy = { summary: string; detail: string; collapsed: boolean; inProcess?: boolean };

/** 普通接收回执不复述整条输入；拒绝和不确定结果仍直接展示。阶段分层：accepted=送达，applied=已应用并核对。 */
export function receiptCopy(receipt: TaskReceipt, selectedConversationId: string): ReceiptCopy {
  const diff = receipt.diff ? diffLine(receipt.diff) : "";
  const detail = `${receipt.targetTitle} · ${receipt.message}${diff ? `\n${diff}` : ""}${receipt.text && !receipt.message.includes(receipt.text) ? `\n原话：${receipt.text}` : ""}`;
  const local = receipt.conversationId === selectedConversationId;

  if (local && receipt.status === "accepted" && receipt.action === "start") {
    return { summary: "任务已接收", detail, collapsed: true };
  }

  if (local && receipt.status === "accepted" && receipt.action === "steer") {
    const queued = receipt.message.includes("继续后生效");

    return { summary: queued ? "修改已保存，点「交还」后生效" : "修改已送达当前任务", detail, collapsed: true };
  }

  if (local && receipt.status === "applied" && receipt.action === "steer") {
    return { summary: "修改已应用并核对", detail, collapsed: true };
  }

  // 停下已由过程行「已停止」和接续那一行说过，不再另起一条「任务已终止」（#103）；停止失败照旧露出。
  if (local && receipt.action === "abort" && (receipt.status === "accepted" || receipt.status === "applied")) {
    return { summary: receipt.message, detail, collapsed: true };
  }

  if (local && receipt.action === "resume" && receipt.status === "accepted") {
    return { summary: "已继续原任务", detail, collapsed: false, inProcess: true };
  }

  return { summary: local ? receipt.message : `${receipt.targetTitle} · ${receipt.message}`, detail, collapsed: false };
}
