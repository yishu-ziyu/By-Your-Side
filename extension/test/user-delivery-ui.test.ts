import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PanelHistory } from "../src/background/panel-history.js";
import type { PanelHistoryItem } from "../src/relay.js";
import type { UserDelivery } from "../../shared/voice.js";
import { mountVoiceUI } from "../src/sidepanel/voice-ui.js";

describe("PanelHistory user delivery deduplication & status update", () => {
  const deliveryA1: UserDelivery = {
    id: "del-1",
    conversationId: "conv-1",
    runId: "run-1",
    kind: "finding",
    text: "竹海工作坊活动邀请已找到。",
    composedAt: 1000,
    status: "composed",
  };

  const deliveryA2: UserDelivery = {
    ...deliveryA1,
    status: "speaking",
  };

  const deliveryA3: UserDelivery = {
    ...deliveryA1,
    status: "played",
  };

  const deliveryB: UserDelivery = {
    id: "del-2",
    conversationId: "conv-1",
    runId: "run-1",
    kind: "reply",
    text: "活动是在本周六举行。",
    composedAt: 2000,
    status: "composed",
  };

  it("records initial user_delivery and assigns monotonic sequence number", () => {
    const history = new PanelHistory();

    const item: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    const entry = history.record(item);
    expect(entry.seq).toBe(1);
    expect(history.since()).toHaveLength(1);
    expect((history.since()[0]!.item as any).msg.event.delivery.id).toBe("del-1");
  });

  it("deduplicates identical user_delivery without creating new sequence number", () => {
    const history = new PanelHistory();

    const item: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    const first = history.record(item);
    const second = history.record(item);

    expect(second.seq).toBe(first.seq);
    expect(history.since()).toHaveLength(1);
  });

  it("updates status in-place (composed -> speaking -> played) without creating new entry", () => {
    const history = new PanelHistory();

    const item1: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    const item2: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA2 },
      },
    };

    const item3: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA3 },
      },
    };

    const first = history.record(item1);
    const speaking = history.record(item2);
    const played = history.record(item3);

    expect(speaking.seq).toBe(first.seq);
    expect(played.seq).toBe(first.seq);
    expect(history.since()).toHaveLength(1);
    expect((history.since()[0]!.item as any).msg.event.delivery.status).toBe("played");
  });

  it("distinguishes deliveries with different ids or conversations", () => {
    const history = new PanelHistory();

    const item1: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    const item2: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryB },
      },
    };

    const item3: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-2",
        event: { kind: "user_delivery", delivery: { ...deliveryA1, conversationId: "conv-2" } },
      },
    };

    const e1 = history.record(item1);
    const e2 = history.record(item2);
    const e3 = history.record(item3);

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(history.since()).toHaveLength(3);
  });

  it("restores history and deduplicates subsequent replayed user delivery", () => {
    const history1 = new PanelHistory();

    const item: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    const e1 = history1.record(item);

    const history2 = new PanelHistory();
    history2.restore(history1.since());
    expect(history2.since()).toHaveLength(1);

    const replayed = history2.record(item);
    expect(replayed.seq).toBe(e1.seq);
    expect(history2.since()).toHaveLength(1);
  });

  it("preserves original text and advances status monotonically, ignoring regressions or text changes", () => {
    const history = new PanelHistory();

    const itemOriginal: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA1 },
      },
    };

    history.record(itemOriginal);

    // Status advances to speaking
    const itemSpeaking: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA2 },
      },
    };

    history.record(itemSpeaking);
    expect((history.since()[0]!.item as any).msg.event.delivery.status).toBe("speaking");

    // Tampered delivery with modified text and regressed status (composed)
    const itemTampered: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: {
          kind: "user_delivery",
          delivery: { ...deliveryA1, text: "篡改后的文本", status: "composed" },
        },
      },
    };

    history.record(itemTampered);
    // Status must not regress, text must remain original
    const recorded = (history.since()[0]!.item as any).msg.event.delivery;
    expect(recorded.status).toBe("speaking");
    expect(recorded.text).toBe(deliveryA1.text);

    // Now advance to played
    const itemPlayed: PanelHistoryItem = {
      kind: "server",
      msg: {
        type: "agent_event",
        conversationId: "conv-1",
        event: { kind: "user_delivery", delivery: deliveryA3 },
      },
    };

    history.record(itemPlayed);
    expect((history.since()[0]!.item as any).msg.event.delivery.status).toBe("played");
    expect((history.since()[0]!.item as any).msg.event.delivery.text).toBe(deliveryA1.text);

    // Subsequent regressive update with status: speaking does nothing
    history.record(itemSpeaking);
    expect((history.since()[0]!.item as any).msg.event.delivery.status).toBe("played");
  });

  it("keeps two valid revisions with the same text pattern as separate entries", () => {
    const history = new PanelHistory();
    const base = { conversationId: "conv-1", runId: "run-1", kind: "finding" as const, composedAt: 1000, status: "composed" as const };
    history.record({ kind: "server", msg: { type: "agent_event", conversationId: "conv-1", event: { kind: "user_delivery", delivery: { ...base, id: "rev-1", text: "时间：周六上午九点。" } } } });
    history.record({ kind: "server", msg: { type: "agent_event", conversationId: "conv-1", event: { kind: "user_delivery", delivery: { ...base, id: "rev-2", text: "时间：周六上午十点。" } } } });
    const rows = history.since();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.item as any).msg.event.delivery.id)).toEqual(["rev-1", "rev-2"]);
    expect(rows.map((row) => (row.item as any).msg.event.delivery.text)).toEqual(["时间：周六上午九点。", "时间：周六上午十点。"]);
  });

  it("keeps fact-chain fields across status updates and history restore", () => {
    const facts = { outcome: "partial" as const, delivered: ["读了三家方案"], remaining: [{ id: "r-1", description: "预约页被登录墙挡住", status: "blocked" as const }], sources: [{ url: "https://fixture.test/offer/a" }] };

    const item = (status: "composed" | "played"): PanelHistoryItem => ({
      kind: "server",
      msg: { type: "agent_event", conversationId: "conv-1", event: { kind: "user_delivery", delivery: { ...deliveryA1, id: "d-facts", facts, status } } },
    });

    const history = new PanelHistory();
    history.record(item("composed"));
    history.record(item("played"));
    const stored = (history.since()[0]!.item as any).msg.event.delivery;
    expect(stored.status).toBe("played");
    expect(stored.facts).toEqual(facts);
    const restored = new PanelHistory();
    restored.restore(history.since());
    expect((restored.since()[0]!.item as any).msg.event.delivery.facts).toEqual(facts);
  });
});

describe("VoiceUI deliver consumption", () => {
  let mockElements: any[];

  function createMockElement(tag = "div"): any {
    const children: any[] = [];
    const attrs = new Map<string, string>();
    const classList = new Set<string>();

    const element: any = {
      tagName: tag.toUpperCase(),
      className: "",
      hidden: false,
      textContent: "",
      innerHTML: "",
      children,
      dataset: {},
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      getAttribute: (k: string) => attrs.get(k) ?? null,
      getContext: () => ({
        fillRect() {},
        clearRect() {},
        beginPath() {},
        arc() {},
        fill() {},
        save() {},
        restore() {},
        scale() {},
      }),
      querySelector: (sel: string) => {
        const found = children.find(c => c.matches?.(sel));

        if (found) return found;
        const created = createMockElement(sel.startsWith("canvas") ? "canvas" : sel.startsWith("button") ? "button" : "div");

        if (sel.startsWith(".")) created.className = sel.slice(1);

        if (sel.startsWith("#")) created.id = sel.slice(1);
        children.push(created);

        return created;
      },
      querySelectorAll: (sel: string) => children.filter(c => c.matches?.(sel)),
      before: (...nodes: any[]) => children.unshift(...nodes),
      after: (...nodes: any[]) => children.push(...nodes),
      append: (...nodes: any[]) => children.push(...nodes),
      appendChild: (node: any) => { children.push(node);

 return node; },
      replaceChildren: (...nodes: any[]) => { children.length = 0; children.push(...nodes); },
      classList: {
        add: (c: string) => classList.add(c),
        remove: (c: string) => classList.delete(c),
        contains: (c: string) => classList.has(c),
      },
      matches: (sel: string) => {
        if (sel.startsWith(".")) return classList.has(sel.slice(1)) || element.className.includes(sel.slice(1));

        if (sel.startsWith("#")) return element.id === sel.slice(1);

        return element.tagName.toLowerCase() === sel.toLowerCase();
      },
    };

    mockElements.push(element);

    return element;
  }

  beforeEach(() => {
    mockElements = [];
    vi.stubGlobal("document", {
      createElement: (tag: string) => createMockElement(tag),
    });
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("window", {
      addEventListener: () => {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates voice-answer text on deliver without self-embellishment", () => {
    const composer = createMockElement("div");
    const input = createMockElement("input");
    input.id = "input";
    const spacer = createMockElement("div");
    spacer.id = "composer-spacer";
    composer.appendChild(input);
    composer.appendChild(spacer);

    const voice = mountVoiceUI(composer, () => "conv-1", () => true);

    const textFinding = "竹海工作坊发来活动邀请，星浦研究发来访谈邀请。";
    voice.deliver({ kind: "finding", text: textFinding });

    const answerEl = mockElements.find(e => e.className && e.className.includes("voice-answer"));
    expect(answerEl).toBeDefined();
    expect(answerEl.textContent).toBe(textFinding);
  });

  it("preserves finding when late ack arrives", () => {
    const composer = createMockElement("div");
    const input = createMockElement("input");
    input.id = "input";
    const spacer = createMockElement("div");
    spacer.id = "composer-spacer";
    composer.appendChild(input);
    composer.appendChild(spacer);

    const voice = mountVoiceUI(composer, () => "conv-1", () => true);

    voice.deliver({ kind: "finding", text: "已找到邮件" });
    voice.deliver({ kind: "ack", text: "好的，收到" });

    const answerEl = mockElements.find(e => e.className && e.className.includes("voice-answer"));
    expect(answerEl.textContent).toBe("已找到邮件");
  });

  it("updates voice-answer when subsequent reply arrives", () => {
    const composer = createMockElement("div");
    const input = createMockElement("input");
    input.id = "input";
    const spacer = createMockElement("div");
    spacer.id = "composer-spacer";
    composer.appendChild(input);
    composer.appendChild(spacer);

    const voice = mountVoiceUI(composer, () => "conv-1", () => true);

    voice.deliver({ kind: "finding", text: "已找到邮件" });
    voice.deliver({ kind: "reply", text: "活动是关于竹海保护的研讨会" });

    const answerEl = mockElements.find(e => e.className && e.className.includes("voice-answer"));
    expect(answerEl.textContent).toBe("活动是关于竹海保护的研讨会");
  });
});
