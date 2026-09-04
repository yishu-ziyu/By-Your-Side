/**
 * 就地确认按钮：解析 mark.actions、点下去对应的用户文本。
 * 纯函数，可单测。视觉是框外双键（不挡正文）。
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
