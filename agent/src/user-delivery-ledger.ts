import { isUserDelivery, type UserDelivery } from "../../shared/voice.js";

export class UserDeliveryLedger {
  private runId: string | null = null;
  private readonly deliveries = new Map<string, UserDelivery>();
  private readonly order: string[] = [];
  private sawFinding = false;

  constructor(private readonly conversationId: string) {}

  beginRun(runId: string | null): void {
    this.runId = runId;
    this.deliveries.clear();
    this.order.length = 0;
    this.sawFinding = false;
  }

  record(delivery: UserDelivery): boolean {
    if (!isUserDelivery(delivery)) return false;

    if (delivery.conversationId !== this.conversationId) return false;

    if (delivery.runId !== this.runId) return false;

    if (this.deliveries.has(delivery.id)) return false;
    this.deliveries.set(delivery.id, { ...delivery });
    this.order.push(delivery.id);

    if (delivery.kind === "finding") this.sawFinding = true;

    return true;
  }

  latest(): UserDelivery | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const d = this.deliveries.get(this.order[i]!)!;

      if (d.kind !== "ack") return { ...d };
    }

    const last = this.order.at(-1);

    return last ? { ...this.deliveries.get(last)! } : null;
  }

  hasFinding(): boolean {
    return this.sawFinding;
  }

  markPlayback(id: string, status: "speaking" | "played"): UserDelivery | null {
    const d = this.deliveries.get(id);

    if (!d) return null;
    const rank: Record<UserDelivery["status"], number> = { composed: 0, speaking: 1, played: 2 };

    if (rank[status] > rank[d.status]) d.status = status;

    return { ...d };
  }
}
