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

interface DeliveryBubbleState {
  official: boolean;
  streaming: boolean;
  cancelled: boolean;
}

type DeliveryPresentation = "present" | "update_text" | "status" | "mark_cancelled" | "ignore";

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
