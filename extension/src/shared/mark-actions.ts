import type { MarkAction, MarkActionId } from "../../../shared/protocol.js";

function parseMarkActions(raw: unknown): MarkAction[] | undefined {
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

export function markActionUserText(id: MarkActionId): "确认" | "取消" {
  return id === "confirm" ? "确认" : "取消";
}

export function isMarkActionId(value: unknown): value is MarkActionId {
  return value === "confirm" || value === "cancel";
}

const DESTRUCTIVE_ZH = /^(删除|清空|支付|发送|归档)/;

const DESTRUCTIVE_EN = /^(delete|remove|pay|send|archive)(\s|$)/i;

function isDestructiveLabel(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");

  if (!t) return false;

  if (DESTRUCTIVE_ZH.test(t)) return true;

  if (DESTRUCTIVE_EN.test(t)) return true;

  return false;
}

export function sendLabelKind(text: string): "send" | "reply" | null {
  const t = text.trim().replace(/\s+/g, " ");

  if (t.startsWith("发送") || /^send(\s|$)/i.test(t)) return "send";

  if (/^(发布|发表|发帖)(评论|回复|动态|帖子|文章|微博)?$/.test(t) || /^(post|publish|tweet)( (it|now|comment|reply))?$/i.test(t)) return "send";

  if (/^(回复|评论|reply|comment)$/i.test(t)) return "reply";

  return null;
}

export function isSendLabel(text: string): boolean {
  return sendLabelKind(text) !== null;
}

export function isPayLabel(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");

  if (!t || /^(支付宝|微信支付|银行卡|apple pay)$/i.test(t)) return false;

  if (/^(确认|立即|去|马上)?(支付|付款)(?!宝|方式)/.test(t)) return true;

  if (/下单并支付|提交订单并支付|确认并支付/.test(t)) return true;

  if (/^(pay|place order|buy now|complete purchase|checkout)\b/i.test(t)) return true;

  return /[¥￥$€£]\s?\d/.test(t) && /支付|付款|购买|下单|pay|buy|order/i.test(t);
}

function confirmLabelForDestructive(text: string): string {
  const t = text.trim();

  if (t.startsWith("清空") || /^clear/i.test(t)) return "清空";

  if (t.startsWith("支付") || /^pay/i.test(t)) return "支付";

  if (t.startsWith("发送") || /^send/i.test(t)) return "发送";

  if (t.startsWith("归档") || /^archive/i.test(t)) return "归档";

  if (/^(delete|remove)\b/i.test(t)) return "Delete";

  return "删除";
}

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
