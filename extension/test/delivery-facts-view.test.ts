/**
 * T06 交付事实链：契约（可选字段、非法拒绝）、面板投影与呈现、时序采样。
 * 断言口径：事实链只来自宿主投影；旧记录缺字段不猜；complete 与未完成项不能并存。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  USER_DELIVERY_FACT_ITEM_MAX,
  USER_DELIVERY_SOURCE_MAX,
  isUserDelivery,
  type UserDelivery,
  type UserDeliveryFacts,
} from "../../shared/voice.js";
import {
  buildDeliveryFactView,
  deliveryPresentation,
  renderDeliveryFacts,
  sourceLabel,
  DeliveryPresentationTiming,
  DELIVERY_FACT_LIST_MAX,
} from "../src/sidepanel/delivery-facts-view.js";

const delivery = (over: Partial<UserDelivery> = {}): UserDelivery => ({
  conversationId: "c1", id: "d-1", runId: "run-1", kind: "finding",
  text: "三家方案比较完成。", composedAt: 100, status: "composed", ...over,
});

const facts = (over: Partial<UserDeliveryFacts> = {}): UserDeliveryFacts => ({
  outcome: "complete", delivered: ["填写姓名"], remaining: [], sources: [{ url: "https://fixture.test/offer/a", title: null }], ...over,
});

describe("交付事实链契约", () => {
  it("接受宿主事实链（含缺失 title），旧记录缺字段照常有效", () => {
    expect(isUserDelivery(delivery({ facts: facts() }))).toBe(true);
    expect(isUserDelivery(delivery())).toBe(true); // 旧记录
    expect(isUserDelivery(delivery({ facts: facts({ sources: [{ url: "https://a.test/x" }] }) }))).toBe(true);
    expect(isUserDelivery(delivery({ facts: facts({ delivered: [] }) }))).toBe(true);
  });

  it("部分完成必须有未完成项；漏项却报 complete 记录边界就失败", () => {
    const partial = facts({ outcome: "partial", remaining: [{ id: "r-1", description: "预约页被登录墙挡住", status: "blocked" }] });
    expect(isUserDelivery(delivery({ facts: partial }))).toBe(true);
    expect(isUserDelivery(delivery({ facts: facts({ outcome: "complete", remaining: [{ id: "r-1", description: "还没做", status: "pending" }] }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ outcome: "partial", remaining: [] }) }))).toBe(true); // 部分完成允许没有登记项（如运行出错）
  });

  it("拒绝错来源、越界与坏状态", () => {
    expect(isUserDelivery(delivery({ facts: facts({ omittedRemaining: 3 }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ sources: [{ url: "javascript:alert(1)" }] }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ sources: [{ url: "file:///etc/passwd" }] }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ sources: [{ url: "https://a.test/x", title: "标题".repeat(200) }] }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ sources: Array.from({ length: USER_DELIVERY_SOURCE_MAX + 1 }, (_, i) => ({ url: `https://a.test/${i}` })) }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ delivered: Array.from({ length: USER_DELIVERY_FACT_ITEM_MAX + 1 }, (_, i) => `项 ${i}`) }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: facts({ remaining: [{ id: "r-1", description: "还没做", status: "done" as never }] }) }))).toBe(false);
    expect(isUserDelivery(delivery({ facts: { outcome: "verified_success" as never, delivered: [], remaining: [], sources: [] } }))).toBe(false);
  });

  it("事实链字段不把业务成功写进交付记录", () => {
    const record = delivery({ facts: facts() });
    expect(JSON.stringify(record)).not.toMatch(/verified_success|successVerified|已完成全部/);
  });
});

// ── 面板投影与呈现 ────────────────────────────────────────────────

describe("交付事实链视图", () => {
  it("没有事实链字段就没有这个块，不把旧记录说成没有未完成项", () => {
    expect(buildDeliveryFactView(null).visible).toBe(false);
    expect(buildDeliveryFactView(undefined).visible).toBe(false);
  });

  it("部分完成显示已完成与未完成清单，未完成项超界说明总数", () => {
    const remaining = Array.from({ length: DELIVERY_FACT_LIST_MAX + 3 }, (_, i) => ({ id: `r-${i}`, description: `第 ${i} 项`, status: "pending" as const }));
    const view = buildDeliveryFactView(facts({ outcome: "partial", delivered: ["读了三家方案"], remaining }));
    expect(view.visible).toBe(true);
    expect(view.tone).toBe("partial");
    expect(view.headline).toContain(`还有 ${remaining.length} 项未完成`);
    expect(view.done).toContain("已完成 1 项");
    expect(view.remaining).toHaveLength(DELIVERY_FACT_LIST_MAX);
    const blocked = buildDeliveryFactView(facts({ outcome: "partial", remaining: [{ id: "r-9", description: "预约页被登录墙挡住", status: "blocked" }] }));
    expect(blocked.remaining[0]?.statusLabel).toBe("执行受阻");
  });

  it("完整交付只列出真实来源，标题缺失时用地址本身", () => {
    const view = buildDeliveryFactView(facts({ sources: [
      { url: "https://fixture.test/offer/a", title: "方案 A" },
      { url: "https://fixture.test/offer/b" },
    ] }));

    expect(view.headline).toBe("已交付 · 来源 2");
    expect(view.sources[0]?.label).toBe("方案 A");
    expect(view.sources[1]?.label).toBe("fixture.test/offer/b");
    expect(sourceLabel("not a url")).toBe("not a url");
  });
});

interface MockEl {
  tagName: string; className: string; textContent: string; title: string; href: string; target: string; rel: string;
  dataset: Record<string, string>; children: MockEl[]; onclick: ((event: { preventDefault: () => void }) => void) | null;
  append(...nodes: MockEl[]): void;
}

function el(tag: string): MockEl {
  return {
    tagName: tag.toUpperCase(), className: "", textContent: "", title: "", href: "", target: "", rel: "",
    dataset: {}, children: [], onclick: null,
    append(...nodes: MockEl[]) { this.children.push(...nodes); },
  };
}

function installDom(): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => el(tag),
    getElementById: () => null,
    head: { append: () => {} },
  });
}

function flatten(root: MockEl | null, out: MockEl[] = []): MockEl[] {
  if (!root) return out;
  out.push(root);

  for (const child of root.children) flatten(child, out);

  return out;
}

beforeEach(() => vi.unstubAllGlobals());

describe("交付事实链 DOM", () => {
  it("完成或未核验的回答不附页脚：来源和已完成清单不打扰普通回合", () => {
    installDom();
    expect(renderDeliveryFacts(delivery({ facts: facts() }))).toBeNull();
    expect(renderDeliveryFacts(delivery({ facts: facts({ outcome: "unverified" }) }))).toBeNull();
    expect(renderDeliveryFacts(delivery({ facts: facts({ outcome: "partial", remaining: [{ id: "r-1", description: "预约页被登录墙挡住", status: "blocked" }] }) }))).not.toBeNull();
  });

  it("来源链接指向宿主记录的真实地址并新开标签页", () => {
    installDom();
    const root = renderDeliveryFacts(delivery({ facts: facts({ outcome: "partial", sources: [{ url: "https://fixture.test/offer/a", title: "方案 A" }] }) })) as unknown as MockEl | null;
    const links = flatten(root).filter((node) => node.tagName === "A");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ href: "https://fixture.test/offer/a", textContent: "方案 A", target: "_blank", rel: "noopener noreferrer" });
  });

  it("没有字段时返回 null；部分完成渲染未完成项并可由宿主接管打开", () => {
    installDom();
    expect(renderDeliveryFacts(delivery())).toBeNull();
    const opened: string[] = [];
    const root = renderDeliveryFacts(delivery({ facts: facts({ outcome: "partial", remaining: [{ id: "r-1", description: "备注未核对", status: "unknown" }] }) }), { openSource: (url) => opened.push(url) }) as unknown as MockEl | null;
    const text = flatten(root).map((node) => node.textContent).join("|");
    expect(text).toContain("备注未核对（结果未知）");
    const link = flatten(root).find((node) => node.tagName === "A");
    expect(link).toBeTruthy();
    let prevented = false;
    link!.onclick?.({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(opened).toEqual(["https://fixture.test/offer/a"]);
  });
});

describe("交付/流的重放与晚到规则", () => {
  it("同 id 重放只更新状态；已落定的正文不被晚到的流覆盖", () => {
    expect(deliveryPresentation({ kind: "delivery" }, undefined)).toBe("present");
    expect(deliveryPresentation({ kind: "delivery" }, { official: true, streaming: false, cancelled: false })).toBe("status");
    expect(deliveryPresentation({ kind: "delivery" }, { official: false, streaming: true, cancelled: false })).toBe("update_text");
    expect(deliveryPresentation({ kind: "stream", phase: "streaming" }, undefined)).toBe("present");
    expect(deliveryPresentation({ kind: "stream", phase: "streaming" }, { official: false, streaming: true, cancelled: false })).toBe("update_text");
    expect(deliveryPresentation({ kind: "stream", phase: "streaming" }, { official: true, streaming: false, cancelled: false })).toBe("ignore");
  });

  it("取过消的前缀不能复活；正式全文可替换未完成前缀，但不会因流事件重新打开", () => {
    expect(deliveryPresentation({ kind: "stream", phase: "cancelled" }, { official: false, streaming: true, cancelled: false })).toBe("mark_cancelled");
    expect(deliveryPresentation({ kind: "stream", phase: "cancelled" }, { official: true, streaming: false, cancelled: false })).toBe("ignore");
    expect(deliveryPresentation({ kind: "stream", phase: "streaming" }, { official: false, streaming: false, cancelled: true })).toBe("ignore");
    expect(deliveryPresentation({ kind: "delivery" }, { official: false, streaming: false, cancelled: true })).toBe("update_text");
  });
});

describe("交付呈现时序采样", () => {
  it("P95 取 nearest-rank，可见性一并记录，样本有界", () => {
    const timing = new DeliveryPresentationTiming();

    for (let i = 1; i <= 50; i += 1) timing.record(0, i <= 45, i);
    const summary = timing.summary();
    expect(summary.count).toBe(50);
    expect(summary.visibleCount).toBe(45);
    expect(summary.p95).toBe(48); // ceil(0.95*50)=48
    expect(summary.samples[0]).toBe(1);
  });
});
