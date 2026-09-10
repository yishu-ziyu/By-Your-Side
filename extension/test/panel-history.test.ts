import { describe, expect, it } from "vitest";
import { PanelHistory } from "../src/background/panel-history.js";
import type { BgToPanel, PanelHistoryItem, PanelToBg } from "../src/relay.js";

describe("PanelHistory", () => {
  it('does not duplicate replayed task receipts and replaces an updated receipt',()=>{
    const history=new PanelHistory();
    const receipt={requestId:'r1',conversationId:'A',source:'voice' as const,action:'steer' as const,runId:'run',text:'预算800',targetTitle:'比价',status:'unknown' as const,message:'结果未知',updatedAt:1};
    const item:PanelHistoryItem={kind:'server',msg:{type:'agent_event',conversationId:'A',event:{kind:'notice',message:receipt.message,receipt}}};
    const first=history.record(item);expect(history.record(item).seq).toBe(first.seq);expect(history.since()).toHaveLength(1);
    const updated={...receipt,status:'accepted' as const,message:'已送达',updatedAt:2};
    const next=history.record({kind:'server',msg:{type:'agent_event',conversationId:'A',event:{kind:'notice',message:updated.message,receipt:updated}}});
    expect(next.seq).toBeGreaterThan(first.seq);expect(history.since()).toHaveLength(1);
    const restored=new PanelHistory();restored.restore(history.since());restored.record(item);expect(restored.since()).toHaveLength(1);
  });
  it("records user and visible server items with strictly increasing sequence numbers", () => {
    const history = new PanelHistory();

    const first = history.record({ kind: "user", text: "继续完成这一步" });
    const second = history.record({ kind: "server", msg: { type: "status", state: "running" } });
    const third = history.record({
      kind: "server",
      msg: { type: "agent_event", event: { kind: "notice", message: "正在读取页面" } },
    });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(history.since()).toEqual([first, second, third]);
  });

  it("returns only entries newer than afterSeq and returns a defensive array", () => {
    const history = new PanelHistory();
    history.record({ kind: "user", text: "第一条" });
    history.record({ kind: "user", text: "第二条" });
    history.record({ kind: "user", text: "第三条" });

    const increment = history.since(1);
    expect(increment.map((entry) => entry.seq)).toEqual([2, 3]);
    increment.pop();
    expect(history.since(1).map((entry) => entry.seq)).toEqual([2, 3]);
    expect(history.since(3)).toEqual([]);
  });

  it("keeps a fixed upper bound without renumbering retained entries", () => {
    const history = new PanelHistory(2);
    history.record({ kind: "user", text: "one" });
    history.record({ kind: "user", text: "two" });
    const latest = history.record({ kind: "user", text: "three" });

    expect(latest.seq).toBe(3);
    expect(history.since()).toEqual([
      { seq: 2, item: { kind: "user", text: "two" }, occurredAt: expect.any(Number) },
      { seq: 3, item: { kind: "user", text: "three" }, occurredAt: expect.any(Number) },
    ]);
    expect(history.since(0).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("clears retained entries but preserves monotonic sequence numbers", () => {
    const history = new PanelHistory();
    history.record({ kind: "user", text: "before clear" });
    history.clear();

    expect(history.since()).toEqual([]);
    expect(history.record({ kind: "user", text: "after clear" }).seq).toBe(2);
  });

  it("rejects invalid limits", () => {
    expect(() => new PanelHistory(0)).toThrow(/positive integer/);
    expect(() => new PanelHistory(1.5)).toThrow(/positive integer/);
  });
});

describe("panel history relay contract", () => {
  it("supports incremental sync and history delivery", () => {
    const sync: PanelToBg = { kind: "sync", afterSeq: 41 };
    const item: PanelHistoryItem = { kind: "user", text: "保留这一轮任务" };
    const history: BgToPanel = { kind: "history", entries: [{ seq: 42, item }] };

    expect(sync).toEqual({ kind: "sync", afterSeq: 41 });
    expect(history).toEqual({ kind: "history", entries: [{ seq: 42, item }] });
  });

  it("retains attachments on user history items", () => {
    const history = new PanelHistory();
    const entry = history.record({
      kind: "user",
      text: "请分析这张截图",
      attachments: [
        {
          id: "att-1",
          type: "image",
          name: "screenshot.png",
          dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    });

    expect(entry.seq).toBe(1);
    expect(entry.item.kind).toBe("user");
    if (entry.item.kind === "user") {
      expect(entry.item.attachments).toHaveLength(1);
      expect(entry.item.attachments?.[0]?.name).toBe("screenshot.png");
    }
  });
});

it('persists one source plan with pending and unexecuted steps across history restore',()=>{
 const history=new PanelHistory(),plan={id:'p1',conversationId:'A',updatedAt:1,steps:[{action:'pause',text:'暂停B',targetId:'B',status:'pending' as const},{action:'resume',text:'继续B',targetId:'B',status:'unexecuted' as const}]};
 const item:PanelHistoryItem={kind:'server',msg:{type:'agent_event',conversationId:'A',event:{kind:'notice',message:'语音计划',plan}}};
 history.record(item);history.record(item);const restored=new PanelHistory();restored.restore(JSON.parse(JSON.stringify(history.since())));restored.record(item);
 expect(restored.since()).toHaveLength(1);expect(restored.since()[0]!.item).toEqual(item);
});
