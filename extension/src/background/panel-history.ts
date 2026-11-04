import type { PanelHistoryEntry, PanelHistoryItem } from "../relay.js";
import { toolStartForUi } from "../../../shared/tool-event-for-ui.js";
import { toolEndForUi } from "../../../shared/user-facing.js";

const DEFAULT_PANEL_HISTORY_LIMIT = 5_000;

export const HISTORY_PERSIST_BUDGET_BYTES = 256 * 1024;

export type StoredPanelHistory = { updatedAt: number; entries: PanelHistoryEntry[]; seqFloor?: number };

const SEQ_RESERVE = 1_000;

function cleanEntry(entry: PanelHistoryEntry): PanelHistoryEntry | null {
  const item = entry?.item;

  if (item?.kind !== "server" || item.msg.type !== "agent_event") return entry;
  const event = item.msg.event;

  if (event.kind === "thinking_delta") return null;

  if (event.kind === "tool_start") return { ...entry, item: { ...item, msg: { ...item.msg, event: toolStartForUi(event) } } };

  if (event.kind === "tool_end" && "resultText" in event) return { ...entry, item: { ...item, msg: { ...item.msg, event: toolEndForUi(event) } } };

  return entry;
}

export function cleanStoredHistory(value: unknown): unknown {
  const list = Array.isArray(value) ? value : (value as StoredPanelHistory | null)?.entries;

  if (!Array.isArray(list)) return value;
  const entries = (list as PanelHistoryEntry[]).flatMap((entry) => { const clean = cleanEntry(entry); return clean ? [clean] : []; });

  return Array.isArray(value) ? entries : { ...(value as StoredPanelHistory), entries };
}

export function historyUpdatedAt(value: unknown): number {
  if (Array.isArray(value)) return 0;
  const at = (value as { updatedAt?: unknown } | null | undefined)?.updatedAt;

  return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

export function historyKeysToDrop(records: Array<{ key: string; updatedAt: number }>, keep: number): string[] {
  if (keep <= 0) return records.map((record) => record.key);

  if (records.length <= keep) return [];

  return [...records]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(keep)
    .map((record) => record.key);
}

export class PanelHistory {
  private readonly entries: PanelHistoryEntry[] = [];
  private nextSeq = 1;

  constructor(private readonly limit = DEFAULT_PANEL_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("PanelHistory limit must be a positive integer");
    }
  }

  record(item: PanelHistoryItem): PanelHistoryEntry {
    const last = this.entries.at(-1);

    if (last && sameStatus(last.item, item)) return last;

    if(item.kind === "server" && item.msg.type === "agent_event" && item.msg.event.kind === "artifact" && item.msg.event.action === "saved") {
      const { content: _content, ...event } = item.msg.event;
      item = {...item,msg:{...item.msg,event}};
    }

    const stream=item.kind==='server'&&item.msg.type==='agent_event'&&item.msg.event.kind==='user_delivery_stream'?item.msg.event.stream:null;
    const completed=item.kind==='server'&&item.msg.type==='agent_event'&&item.msg.event.kind==='user_delivery'?item.msg.event.delivery:null;

    if(stream||completed){
      const id=stream?.id??completed!.id;

      for(let i=this.entries.length-1;i>=0;i--){
        const old=this.entries[i]!.item;

        if(old.kind==='server'&&old.msg.type==='agent_event'&&old.msg.event.kind==='user_delivery_stream'&&old.msg.event.stream.id===id&&item.kind==='server'&&old.msg.conversationId===item.msg.conversationId)this.entries.splice(i,1);
      }
    }

    if (contextUsage(item)) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const old = this.entries[i]!.item;

        if (contextUsage(old) && old.kind === "server" && item.kind === "server" && old.msg.conversationId === item.msg.conversationId) this.entries.splice(i, 1);
      }
    }

    const plan=taskPlan(item);

    if(plan){
      const index=this.entries.findIndex(e=>{const old=taskPlan(e.item);

return old?.id===plan.id&&old.conversationId===plan.conversationId;});

      if(index>=0){const old=this.entries[index]!;

if(taskPlan(old.item)!.updatedAt>=plan.updatedAt)return old;this.entries.splice(index,1);}
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

  retryTarget(seq: number, text: string): { original: import("../../../shared/protocol.js").ClientMessage } | "delivered" | "gone" {
    const entry = this.entries.find(item => item.seq === seq);

    if (entry?.item.kind !== "user" || entry.item.text !== text) return "gone";

    return entry.item.undelivered ? { original: entry.item.undelivered.original } : "delivered";
  }

  markDelivered(seq: number): void {
    const entry = this.entries.find(item => item.seq === seq);

    if (entry?.item.kind === "user") delete entry.item.undelivered;
  }

  since(afterSeq = 0): PanelHistoryEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq);
  }

  persistWindow(budgetBytes: number): PanelHistoryEntry[] {
    const encoder = new TextEncoder();
    const out: PanelHistoryEntry[] = [];
    let bytes = 0;

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      const size = encoder.encode(JSON.stringify(entry)).length + 1;

      if (out.length > 0 && bytes + size > budgetBytes) break;
      out.push(entry);
      bytes += size;
    }

    return out.reverse();
  }

  restore(value: unknown): void {
    const list = Array.isArray(value) ? value : (value as StoredPanelHistory | null)?.entries;

    if (!Array.isArray(list)) return;

    for (const entry of list) {
      if (!entry || !Number.isInteger(entry.seq) || !entry.item || entry.seq < this.nextSeq) continue;
      this.entries.push(entry);
      this.nextSeq = entry.seq + 1;
    }

    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    const floor = value && typeof value === "object" && "seqFloor" in value ? value.seqFloor : undefined;

    if (typeof floor === "number" && Number.isSafeInteger(floor) && floor > this.nextSeq) this.nextSeq = floor;
  }

  seqFloor(): number {
    return this.nextSeq + SEQ_RESERVE;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

function sameStatus(a: PanelHistoryItem, b: PanelHistoryItem): boolean {
  return a.kind === "server" && b.kind === "server" && a.msg.type === "status" && b.msg.type === "status"
    && a.msg.state === b.msg.state && a.msg.conversationId === b.msg.conversationId && a.msg.sessionId === b.msg.sessionId;
}

function contextUsage(item: PanelHistoryItem): boolean {
  return item.kind === "server" && item.msg.type === "agent_event" && item.msg.event.kind === "context_usage";
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
