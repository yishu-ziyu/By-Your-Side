

/** 链接文字只用地址本身：标题要另取证，不能由模型正文补。 */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURI(parsed.pathname === "/" ? "" : parsed.pathname);

    return `${parsed.host}${path}`.slice(0, 120);
  }
  catch {
    return url.slice(0, 120);
  }
}

/** 面板已有的交付气泡状态（只按正式/流式/取消区分，不存正文）。 */
interface DeliveryBubbleState {
  official: boolean;
  streaming: boolean;
  cancelled: boolean;
}

type DeliveryPresentation = "present" | "update_text" | "status" | "mark_cancelled" | "ignore";

/**
 * 面板对一次交付／流事件的处理决定（纯函数）：
 * - 同 deliveryId 重放（含历史回放）只更新状态，不重复呈现；
 * - 已正式落定的结果不被晚到的流覆盖（旧流只能归到旧 id，不能改写新正式结果）；
 * - 取过消的流前缀不能复活；正式交付若真是权威全文，可以替换掉那个未完成前缀。
 */
export function deliveryPresentation(event: {
  kind: "delivery" | "stream";
  phase?: "streaming" | "cancelled";
}, existing: DeliveryBubbleState | undefined): DeliveryPresentation {
  if (event.kind === "delivery") {
    if (!existing) {
      return "present";
    }

    if (existing.streaming || existing.cancelled) {
      return "update_text";
    }

    return "status";
  }

  if (event.phase === "cancelled") {
    return existing?.streaming ? "mark_cancelled" : "ignore";
  }

  if (!existing) {
    return "present";
  }

  return existing.streaming ? "update_text" : "ignore";
}
