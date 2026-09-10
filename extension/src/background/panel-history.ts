import type { PanelHistoryEntry, PanelHistoryItem } from "../relay.js";

export const DEFAULT_PANEL_HISTORY_LIMIT = 5_000;

/**
 * Service worker 生命周期内的侧栏回放日志。
 *
 * seq 永不复用；超过上限时只淘汰最旧条目。因此面板持有的旧游标即使落在
 * 已截断区间，since() 也会返回当前仍保留的完整窗口。
 */
export class PanelHistory {
  private readonly entries: PanelHistoryEntry[] = [];
  private nextSeq = 1;

  constructor(private readonly limit = DEFAULT_PANEL_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("PanelHistory limit must be a positive integer");
    }
  }

  record(item: PanelHistoryItem): PanelHistoryEntry {
    const stream=item.kind==='server'&&item.msg.type==='agent_event'&&item.msg.event.kind==='user_delivery_stream'?item.msg.event.stream:null;
    const completed=item.kind==='server'&&item.msg.type==='agent_event'&&item.msg.event.kind==='user_delivery'?item.msg.event.delivery:null;
    if(stream||completed){
      const id=stream?.id??completed!.id;
      for(let i=this.entries.length-1;i>=0;i--){
        const old=this.entries[i]!.item;
        if(old.kind==='server'&&old.msg.type==='agent_event'&&old.msg.event.kind==='user_delivery_stream'&&old.msg.event.stream.id===id&&item.kind==='server'&&old.msg.conversationId===item.msg.conversationId)this.entries.splice(i,1);
      }
    }
    const plan=taskPlan(item);
    if(plan){
      const index=this.entries.findIndex(e=>{const old=taskPlan(e.item);return old?.id===plan.id&&old.conversationId===plan.conversationId;});
      if(index>=0){const old=this.entries[index]!;if(taskPlan(old.item)!.updatedAt>=plan.updatedAt)return old;this.entries.splice(index,1);}
    }
    const receipt = taskReceipt(item);
    if (receipt) {
      const index = this.entries.findIndex(e=>{
        const old=taskReceipt(e.item);
        return old?.requestId===receipt.requestId && old.conversationId===receipt.conversationId;
      });
      if (index>=0) {
        const existing=this.entries[index]!, old=taskReceipt(existing.item)!;
        if (old.updatedAt>=receipt.updatedAt) return existing;
        this.entries.splice(index,1);
      }
    }
    const delivery = userDelivery(item);
    if (delivery) {
      const index = this.entries.findIndex(e => {
        const old = userDelivery(e.item);
        return old?.id === delivery.id && old.conversationId === delivery.conversationId;
      });
      if (index >= 0) {
        const existing = this.entries[index]!;
        const old = userDelivery(existing.item)!;
        const oldRank = DELIVERY_STATUS_RANK[old.status] ?? -1;
        const newRank = DELIVERY_STATUS_RANK[delivery.status] ?? -1;
        if (newRank > oldRank && existing.item.kind === 'server' && existing.item.msg.type === 'agent_event') {
          const updated = { ...old, status: delivery.status };
          existing.item = {
            ...existing.item,
            msg: {
              ...existing.item.msg,
              event: {
                ...existing.item.msg.event,
                delivery: updated,
              } as any,
            },
          };
        }
        return existing;
      }
    }
    const entry = { seq: this.nextSeq++, item, occurredAt: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return entry;
  }

  markUndelivered(seq: number, original: import("../../../shared/protocol.js").ClientMessage): void {
    const entry = this.entries.find(item => item.seq === seq);
    if (entry?.item.kind === "user") entry.item.undelivered = { original };
  }

  since(afterSeq = 0): PanelHistoryEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq);
  }

  restore(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || !Number.isInteger(entry.seq) || !entry.item || entry.seq < this.nextSeq) continue;
      this.entries.push(entry);
      this.nextSeq = entry.seq + 1;
    }
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

function taskReceipt(item:PanelHistoryItem) {
  return item.kind==='server' && item.msg.type==='agent_event' && item.msg.event.kind==='notice' ? item.msg.event.receipt : undefined;
}

function taskPlan(item:PanelHistoryItem){return item.kind==='server'&&item.msg.type==='agent_event'&&item.msg.event.kind==='notice'?item.msg.event.plan:undefined;}

function userDelivery(item: PanelHistoryItem): { id: string; conversationId: string; status: string; text: string } | undefined {
  return item.kind === 'server' && item.msg.type === 'agent_event' && item.msg.event.kind === 'user_delivery'
    ? (item.msg.event as any).delivery
    : undefined;
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  composed: 0,
  speaking: 1,
  played: 2,
};
