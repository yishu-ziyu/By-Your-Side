/**
 * 就地确认按钮：解析 mark.actions、点下去对应的用户文本、危险词判定。
 * 纯函数，可单测。视觉是光标名牌上的双键（手拿住目标，键跟手走）。
 */
import type { MarkAction, MarkActionId } from "../../../shared/protocol.js";

export function parseMarkActions(raw: unknown): MarkAction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: MarkAction[] = [];
  const seen = new Set<MarkActionId>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { id?: unknown; label?: unknown };
    if (rec.id !== "confirm" && rec.id !== "cancel") continue;
    if (typeof rec.label !== "string") continue;
    const label = rec.label.trim().slice(0, 16);
    if (!label || seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push({ id: rec.id, label });
    if (out.length >= 2) break;
  }
  if (out.length === 0) return undefined;
  out.sort((a, b) => (a.id === "confirm" ? 0 : 1) - (b.id === "confirm" ? 0 : 1));
  return out;
}

/** 点按钮后注入会话的文本，与侧栏打「确认」「取消」同一条路。 */
export function markActionUserText(id: MarkActionId): "确认" | "取消" {
  return id === "confirm" ? "确认" : "取消";
}

export function isMarkActionId(value: unknown): value is MarkActionId {
  return value === "confirm" || value === "cancel";
}

const DESTRUCTIVE_ZH = /^(删除|清空|支付|发送|归档)/;
const DESTRUCTIVE_EN = /^(delete|remove|pay|send|archive)(\s|$)/i;

/** 要点的控件文案是否属于删除 / 清空 / 支付 / 发送 / 归档。普通「分享」「编辑」「更多」不是。 */
export function isDestructiveLabel(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return false;
  if (DESTRUCTIVE_ZH.test(t)) return true;
  if (DESTRUCTIVE_EN.test(t)) return true;
  return false;
}

export function confirmLabelForDestructive(text: string): string {
  const t = text.trim();
  if (/^清空/.test(t) || /^clear/i.test(t)) return "清空";
  if (/^支付/.test(t) || /^pay/i.test(t)) return "支付";
  if (/^发送/.test(t) || /^send/i.test(t)) return "发送";
  if (/^归档/.test(t) || /^archive/i.test(t)) return "归档";
  if (/^(delete|remove)\b/i.test(t)) return "Delete";
  return "删除";
}

/**
 * 若模型调用 mark 时未显式提供 actions，但 label 表达了确认意图（如「待归档」「待删除」「待确认」或命中危险词），
 * 兜底推导 confirm/cancel 双键并在名牌上拿住，防止模型幻觉“光标停在上面”而页面光标未就地拿住。
 */
export function resolveImplicitMarkActions(label?: string, actions?: unknown): MarkAction[] | undefined {
  const parsed = parseMarkActions(actions);
  if (parsed) return parsed;
  if (!label) return undefined;
  const t = label.trim();
  if (!t) return undefined;
  if (t.startsWith("待")) {
    const actionName = t.slice(1).trim() || "确认";
    return [
      { id: "confirm", label: actionName.slice(0, 16) },
      { id: "cancel", label: "取消" },
    ];
  }
  if (isDestructiveLabel(t)) {
    const actionName = confirmLabelForDestructive(t);
    return [
      { id: "confirm", label: actionName },
      { id: "cancel", label: "取消" },
    ];
  }
  return undefined;
}

/** 侧栏里这句话算放行刚才拦住的那一下。 */
export function isAffirmativeReply(text: string): boolean {
  return /^(确认|是的?|继续|好的?|yes|ok|okay|confirm)\s*[。.!！]?$/i.test(text.trim());
}

/** 侧栏里这句话算撤销刚才拦住的那一下（与点名牌「取消」同效）。 */
export function isCancelReply(text: string): boolean {
  return /^(取消|算了|不用了?|不要|别|否|no|nope|cancel)\s*[。.!！]?$/i.test(text.trim());
}
