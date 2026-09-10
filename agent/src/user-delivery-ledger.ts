import { isUserDelivery, type UserDelivery } from "../../shared/voice.js";

/** 每 run 的正式交付台账：只记账，不是消息框架。接线（beginRun/record/markPlayback）由宿主完成。 */
export class UserDeliveryLedger {
  private runId: string | null = null;
  private readonly deliveries = new Map<string, UserDelivery>();
  private readonly order: string[] = [];
  private sawFinding = false;

  constructor(private readonly conversationId: string) {}

  /** 新 run 开账并清空本 run；之后旧 run 的迟到交付不能写入。null-run 闲聊允许。 */
  beginRun(runId: string | null): void {
    this.runId = runId;
    this.deliveries.clear();
    this.order.length = 0;
    this.sawFinding = false;
  }

  /** 首次有效 true；重复 id、同 id 改文、越界（非法/别会话/旧 run）一律 false。 */
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

  /** 本 run 最近的有效交付副本；迟到 ack 不覆盖 finding/reply。 */
  latest(): UserDelivery | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const d = this.deliveries.get(this.order[i]!)!;
      if (d.kind !== "ack") return { ...d };
    }
    const last = this.order.at(-1);
    return last ? { ...this.deliveries.get(last)! } : null;
  }

  /** 仅表示本 run 曾交付 finding；不被 ack 改变。 */
  hasFinding(): boolean {
    return this.sawFinding;
  }

  /** 只更新本 run 已知 id 的播放状态；不倒退、不造正文，未知 id 返回 null。 */
  markPlayback(id: string, status: "speaking" | "played"): UserDelivery | null {
    const d = this.deliveries.get(id);
    if (!d) return null;
    const rank: Record<UserDelivery["status"], number> = { composed: 0, speaking: 1, played: 2 };
    if (rank[status] > rank[d.status]) d.status = status;
    return { ...d };
  }
}
