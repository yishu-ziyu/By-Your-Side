/**
 * T06 成果/依据/未完成项视图：只读投影宿主事实链（`UserDelivery.facts`），把结论与正文放前面，
 * 依据（本 run 真实读到的页面）和未完成项单独成块；过程仍留在 T03 运行块里默认收起。
 *
 * 诚实边界：
 * - 只消费正式交付记录里的字段；旧记录缺字段时不渲染、不从叙述猜已核验结果。
 * - `complete` 只在事实链无未完成项时成立（记录边界已校验）；界面不把它说成「业务已核验成功」。
 * - 来源链接直接指向宿主记录的真实地址；不新建下载链接、不导出文件。
 * - 呈现时序：收到交付信封 → 结果可见的下一帧；采样结果只描述本轮样本。
 */
import type { UserDelivery, UserDeliveryFacts } from "../../../shared/voice.js";

export const DELIVERY_TIMING_SAMPLE_MAX = 100;
export const DELIVERY_FACT_LIST_MAX = 4;

export const REMAINING_STATUS_LABEL: Record<string, string> = {
  pending: "未完成",
  blocked: "执行受阻",
  unknown: "结果未知",
};

export interface DeliveryFactView {
  visible: boolean;
  tone: "complete" | "partial";
  headline: string;
  done: string;
  remaining: { id: string; description: string; statusLabel: string }[];
  remainingTotal: number;
  delivered: string[];
  sources: { url: string; label: string }[];
}

/** 链接文字只用地址本身：标题要另取证，不能由模型正文补。 */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURI(parsed.pathname === "/" ? "" : parsed.pathname);
    return `${parsed.host}${path}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function remainingLine(item: { description: string; statusLabel: string }): string {
  return `${item.description}（${item.statusLabel}）`;
}

/** 纯投影：没有事实链字段就没有这个块；缺字段不说成「没有未完成项」。 */
export function buildDeliveryFactView(facts: UserDeliveryFacts | undefined | null): DeliveryFactView {
  const empty: DeliveryFactView = { visible: false, tone: "complete", headline: "", done: "", remaining: [], remainingTotal: 0, delivered: [], sources: [] };
  if (!facts) return empty;
  const remaining = facts.remaining
    .slice(0, DELIVERY_FACT_LIST_MAX)
    .map((item) => ({ id: item.id, description: item.description, statusLabel: REMAINING_STATUS_LABEL[item.status] ?? item.status }));
  const delivered = facts.delivered.slice(0, DELIVERY_FACT_LIST_MAX);
  const sources = facts.sources.map((source) => ({ url: source.url, label: source.title?.trim() || sourceLabel(source.url) }));
  const tone: DeliveryFactView["tone"] = facts.outcome === "partial" ? "partial" : "complete";
  const remainingTotal = facts.remaining.length + (facts.omittedRemaining ?? 0);
  const deliveredTotal = facts.delivered.length + (facts.omittedDelivered ?? 0);
  const headline = facts.outcome === "partial"
    ? remainingTotal ? `部分完成 · 还有 ${remainingTotal} 项未完成` : "部分完成"
    : facts.outcome === "unverified" ? "已交付 · 完成情况未核验"
      : sources.length ? `已交付 · 来源 ${sources.length}` : "已交付";
  const done = delivered.length ? `已完成 ${deliveredTotal} 项：${delivered.join("、")}${deliveredTotal > delivered.length ? "…" : ""}` : "";
  const visible = facts.outcome !== "complete" || remaining.length > 0 || sources.length > 0 || delivered.length > 0;
  return { visible, tone, headline, done, remaining, remainingTotal, delivered, sources };
}

export interface DeliveryFactViewOptions {
  /** 打开来源的真实页面；面板传 window.open，测试可注入替身。 */
  openSource?: (url: string) => void;
}

/** 面板已有的交付气泡状态（只按正式/流式/取消区分，不存正文）。 */
export interface DeliveryBubbleState {
  official: boolean;
  streaming: boolean;
  cancelled: boolean;
}

export type DeliveryPresentation = "present" | "update_text" | "status" | "mark_cancelled" | "ignore";

/**
 * 面板对一次交付／流事件的处理决定（纯函数）：
 * - 同 deliveryId 重放（含历史回放）只更新状态，不重复呈现；
 * - 已正式落定的结果不被晚到的流覆盖（旧流只能归到旧 id，不能改写新正式结果）；
 * - 取过消的流前缀不能复活；正式交付若真是权威全文，可以替换掉那个未完成前缀。
 */
export function deliveryPresentation(
  event: { kind: "delivery" | "stream"; phase?: "streaming" | "cancelled" },
  existing: DeliveryBubbleState | undefined,
): DeliveryPresentation {
  if (event.kind === "delivery") {
    if (!existing) return "present";
    if (existing.streaming || existing.cancelled) return "update_text";
    return "status";
  }
  if (event.phase === "cancelled") return existing?.streaming ? "mark_cancelled" : "ignore";
  if (!existing) return "present";
  return existing.streaming ? "update_text" : "ignore";
}

/**
 * 结果块的 DOM：标题行 + 已完成 + 未完成清单 + 来源清单。
 * 正文仍由调用方渲染；这里只加事实链能证明的部分。
 */
export function renderDeliveryFacts(delivery: UserDelivery, options: DeliveryFactViewOptions = {}): HTMLElement | null {
  const view = buildDeliveryFactView(delivery.facts ?? null);
  if (!view.visible) return null;
  ensureStyles();
  const root = document.createElement("div");
  root.className = "delivery-facts";
  root.dataset.deliveryId = delivery.id;
  root.dataset.outcome = view.tone;
  const head = document.createElement("p");
  head.className = "delivery-facts-head";
  head.textContent = view.headline;
  root.append(head);
  if (view.done) {
    const done = document.createElement("p");
    done.className = "delivery-facts-done";
    done.textContent = view.done;
    root.append(done);
  }
  if (view.remaining.length) {
    const list = document.createElement("ul");
    list.className = "delivery-facts-remaining";
    for (const item of view.remaining) {
      const row = document.createElement("li");
      row.dataset.resultId = item.id;
      row.textContent = remainingLine(item);
      list.append(row);
    }
    if (view.remainingTotal > view.remaining.length) {
      const more = document.createElement("li");
      more.className = "delivery-facts-more";
      more.textContent = `…等共 ${view.remainingTotal} 项未完成`;
      list.append(more);
    }
    root.append(list);
  }
  if (view.sources.length) {
    const sources = document.createElement("div");
    sources.className = "delivery-facts-sources";
    const label = document.createElement("span");
    label.className = "delivery-facts-sources-label";
    label.textContent = "来源";
    sources.append(label);
    for (const source of view.sources) {
      const link = document.createElement("a");
      link.className = "delivery-source";
      link.href = source.url;
      link.textContent = source.label;
      link.title = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (options.openSource) {
        link.onclick = (event: Event) => {
          event.preventDefault();
          options.openSource!(source.url);
        };
      }
      sources.append(link);
    }
    root.append(sources);
  }
  return root;
}

/** 「收到正式交付 → 结果可见的下一帧」采样器；只在真实面板里被调用。 */
export class DeliveryPresentationTiming {
  private readonly samples: { ms: number; visible: boolean }[] = [];

  record(startedAt: number, visible: boolean, now: number = performance.now()): void {
    this.samples.push({ ms: Math.max(0, now - startedAt), visible });
    if (this.samples.length > DELIVERY_TIMING_SAMPLE_MAX) this.samples.shift();
  }

  summary(): { count: number; visibleCount: number; p95: number | null; samples: number[] } {
    const considered = this.samples.map((sample) => ({ ...sample }));
    const sorted = considered.map((sample) => sample.ms).sort((a, b) => a - b);
    const all = [...this.samples].map((sample) => sample.ms).sort((a, b) => a - b);
    return {
      count: considered.length,
      visibleCount: considered.filter((sample) => sample.visible).length,
      p95: sorted.length ? sorted[Math.ceil(0.95 * sorted.length) - 1]! : null,
      samples: all,
    };
  }
}

let stylesInjected = false;
/** 侧栏样式已含同名规则时不再注入；单测环境不需要样式。 */
function ensureStyles(): void {
  if (stylesInjected || typeof document === "undefined" || typeof document.createElement !== "function") return;
  if (document.getElementById("delivery-facts-styles")) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "delivery-facts-styles";
  style.textContent = [
    ".delivery-facts{margin-top:6px;padding-top:6px;border-top:0.5px solid var(--glass-border-subtle,rgba(120,110,90,.25));font-size:12px;line-height:1.55;color:var(--text-secondary,#6b6257)}",
    ".delivery-facts .delivery-facts-head{margin:0;color:var(--text-primary,#2f2a24);font-weight:600}",
    ".delivery-facts[data-outcome=partial] .delivery-facts-head{color:var(--warn-text,#8a5a1f)}",
    ".delivery-facts .delivery-facts-done{margin:2px 0 0}",
    ".delivery-facts .delivery-facts-remaining,.delivery-facts .delivery-facts-sources{margin:4px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 10px}",
    ".delivery-facts .delivery-facts-remaining li{width:100%}",
    ".delivery-facts .delivery-facts-more{color:var(--text-tertiary,#8a8175)}",
    ".delivery-facts .delivery-facts-sources-label{color:var(--text-tertiary,#8a8175)}",
    ".delivery-facts a.delivery-source{color:var(--link,#3a6ea5);text-decoration:none;border-bottom:0.5px solid currentColor;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ].join("");
  document.head?.append(style);
}
