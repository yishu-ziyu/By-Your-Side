import type { TaskReceipt, TaskReceiptDiff } from "../../../shared/task-actions.js";

function diffLine(diff: TaskReceiptDiff): string {
  const changed = diff.changed.map((change) => `${change.attribute}：${change.from} → ${change.to}`).join("；");
  const preserved = diff.preserved.length ? `；${diff.preserved.join("、")}保持不变` : "";

  return `${diff.target}：${changed}${preserved}`;
}

type ReceiptCopy = { summary: string; detail: string; collapsed: boolean; inProcess?: boolean };

export function receiptCopy(receipt: TaskReceipt, selectedConversationId: string): ReceiptCopy {
  const diff = receipt.diff ? diffLine(receipt.diff) : "";
  const detail = `${receipt.targetTitle} · ${receipt.message}${diff ? `\n${diff}` : ""}${receipt.text && !receipt.message.includes(receipt.text) ? `\n原话：${receipt.text}` : ""}`;
  const local = receipt.conversationId === selectedConversationId;

  if (local && receipt.status === "accepted" && receipt.action === "start") {
    return { summary: "任务已接收", detail, collapsed: true };
  }

  if (local && receipt.status === "accepted" && receipt.action === "steer") {
    if (receipt.message.startsWith("选择已保存，自动继续未确认")) return { summary: receipt.message, detail, collapsed: false };
    const queued = receipt.message.includes("继续后生效");

    return { summary: queued ? "修改已保存，点「交还」后生效" : "修改已送达当前任务", detail, collapsed: true };
  }

  if (local && receipt.status === "applied" && receipt.action === "steer") {
    return { summary: "修改已应用并核对", detail, collapsed: true };
  }

  if (local && receipt.action === "abort" && (receipt.status === "accepted" || receipt.status === "applied")) {
    return { summary: receipt.message, detail, collapsed: true };
  }

  if (local && receipt.action === "resume" && receipt.status === "accepted") {
    return { summary: "已继续原任务", detail, collapsed: false, inProcess: true };
  }

  return { summary: local ? receipt.message : `${receipt.targetTitle} · ${receipt.message}`, detail, collapsed: false };
}
