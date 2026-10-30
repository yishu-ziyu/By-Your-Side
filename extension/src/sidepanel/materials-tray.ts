/**
 * 输入框上方的材料夹：把真正会随这一句送出的页面、选区、标签页和附件放在同一个地方。
 *
 * 只投影现有草稿，不另存一套材料，也不改变发送协议：
 * - 当前页或选区来源页由发送流程自动带入，所以标成不可移出；
 * - @ 标签页、选区和附件仍走原来的 tabMentions / pendingAsk / AttachmentsManager；
 * - 批量移出只调用这些现有入口，撤销时恢复移出前的草稿快照。
 */
import { createElement as icon, ChevronDown, FileText, Globe2, Plus, TextQuote } from "lucide";
import type { PendingAsk } from "../shared/ask-selection.js";
import type { AttachmentSnapshot } from "./attachments.js";
import type { TaskActionRequest, TaskReceipt } from "../../../shared/task-actions.js";
import { siteGlyph } from "./answer-actions.js";
import { hostOf, type MentionedTab } from "./tab-mentions.js";

export interface TrayPage {
  tabId: number;
  title: string;
  url: string;
}

export type TrayMaterialKind = "page" | "selection" | "attachment";

export interface TrayMaterial {
  key: string;
  kind: TrayMaterialKind;
  label: string;
  detail: string;
  state: "ready" | "reading" | "unread" | "context";
  status: string;
  removable: boolean;
  tabId?: number;
  attachmentId?: string;
}

export interface TrayRemoval {
  kind: "selection" | "mention" | "attachment";
  key: string;
  tabId?: number;
  attachmentId?: string;
}

interface MaterialsTrayOptions {
  root: HTMLElement;
  app: HTMLElement;
  inputHasText(): boolean;
  conversationId(): string;
  onRetry(request: TaskActionRequest): boolean;
  onReceiptDetails(receipt: TaskReceipt): void;
  page(): TrayPage | null;
  selection(): PendingAsk | null;
  mentions(): MentionedTab[];
  attachments(): AttachmentSnapshot[];
  onAdd(): void;
  onMention(): void;
  onAddFiles(files: File[]): void;
  /** 移出真实草稿，返回能把这次移出恢复回来的函数。 */
  onRemove(items: TrayRemoval[]): (() => void) | void;
}

const CLIP_LABEL = 34;

function clip(text: string, max = CLIP_LABEL): string {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pageHost(page: TrayPage): string {
  return hostOf(page.url) || page.title || "网页";
}

function mentionState(status: MentionedTab["status"]): TrayMaterial["state"] {
  if (status === "read") return "ready";
  if (status === "unread") return "unread";

  return "reading";
}

function mentionStatus(status: MentionedTab["status"]): string {
  if (status === "read") return "已读";
  if (status === "unread") return "读不到";

  return "待读";
}

export class MaterialsTray {
  private readonly root: HTMLElement;
  private readonly app: HTMLElement;
  private selected = new Set<string>();
  private materials: TrayMaterial[] = [];
  private lastSignature = "";
  private previousCount = -1;
  private expanded = false;
  private readonly deliveries = new Map<string, { request: TaskActionRequest; receipt: TaskReceipt | null }>();
  private undo: { label: string; restore: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: MaterialsTrayOptions) {
    this.root = opts.root;
    this.app = opts.app;
    this.root.id = "materials-tray-root";
    this.root.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.root.classList.add("is-over");
    });
    this.root.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && this.root.contains(event.relatedTarget)) return;
      this.root.classList.remove("is-over");
    });
    this.root.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      this.root.classList.remove("is-over");
      opts.onAddFiles(Array.from(event.dataTransfer.files));
    });
  }

  sync(): void {
    this.materials = this.collect();
    const draft = this.opts.inputHasText() || this.materials.some((item) => item.removable);
    const show = draft || !!this.delivery();
    this.app.classList.toggle("materials-tray-active", draft);
    this.root.hidden = !show;

    for (const key of [...this.selected]) {
      if (!this.materials.some((item) => item.key === key && item.removable)) this.selected.delete(key);
    }

    if (!show) {
      this.lastSignature = "";
      this.root.replaceChildren();

      return;
    }

    const signature = JSON.stringify({ draft, expanded: this.expanded, delivery: this.delivery(), materials: this.materials, selected: [...this.selected], undo: this.undo?.label ?? null });

    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.render(draft);
  }

  noteRequestSent(request: TaskActionRequest): void {
    this.deliveries.set(request.conversationId, { request, receipt: null });
    this.sync();
  }

  noteReceipt(receipt: TaskReceipt): void {
    const delivery = this.deliveries.get(receipt.conversationId);

    if (!delivery || delivery.request.requestId !== receipt.requestId) return;
    if (receipt.status === "accepted" || receipt.status === "applied") this.deliveries.delete(receipt.conversationId);
    else delivery.receipt = receipt;
    this.sync();
  }

  forgetRequest(conversationId: string, requestId: string): void {
    if (this.deliveries.get(conversationId)?.request.requestId !== requestId) return;
    this.deliveries.delete(conversationId);
    this.sync();
  }

  private delivery() {
    return this.deliveries.get(this.opts.conversationId());
  }

  private collect(): TrayMaterial[] {
    const out: TrayMaterial[] = [];
    const selection = this.opts.selection();
    const current = selection
      ? { tabId: selection.tabId, title: selection.title, url: selection.url }
      : this.opts.page();

    if (current) {
      out.push({
        key: `page:${current.tabId}`,
        kind: "page",
        label: current.title || pageHost(current),
        detail: selection ? `${pageHost(current)} · 选区来源` : `${pageHost(current)} · 自动带入`,
        state: "context",
        status: "自动带入",
        removable: false,
        tabId: current.tabId,
      });
    }

    if (selection) {
      out.push({
        key: `selection:${selection.tabId}`,
        kind: "selection",
        label: `「${clip(selection.text)}」`,
        detail: "选中文字 · 原文随任务送出",
        state: "context",
        status: "原文",
        removable: true,
        tabId: selection.tabId,
      });
    }

    const seenTabs = new Set(out.flatMap((item) => item.tabId === undefined ? [] : [item.tabId]));

    for (const mention of this.opts.mentions()) {
      if (seenTabs.has(mention.tabId)) continue;
      seenTabs.add(mention.tabId);
      out.push({
        key: `mention:${mention.tabId}`,
        kind: "page",
        label: mention.title || hostOf(mention.url) || "标签页",
        detail: `${hostOf(mention.url) || "网页"} · ${mentionStatus(mention.status)}`,
        state: mentionState(mention.status),
        status: mentionStatus(mention.status),
        removable: true,
        tabId: mention.tabId,
      });
    }

    for (const attachment of this.opts.attachments()) {
      out.push({
        key: `attachment:${attachment.id}`,
        kind: "attachment",
        label: attachment.name,
        detail: attachment.detail,
        state: attachment.state,
        status: attachment.state === "ready" ? "已读" : "在读取",
        removable: attachment.state === "ready",
        attachmentId: attachment.id,
      });
    }

    return out;
  }

  private render(draft: boolean): void {
    const count = this.materials.length;
    const removables = this.materials.filter((item) => item.removable);
    const allSelected = removables.length > 0 && removables.every((item) => this.selected.has(item.key));
    const shell = document.createElement("section");
    shell.className = "materials-tray";
    shell.setAttribute("aria-label", `这次任务，共 ${count} 项材料`);

    const head = document.createElement("div");
    head.className = "mt-head";
    const folder = document.createElement("span");
    folder.className = "mt-folder";
    folder.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "mt-title";
    title.textContent = "这次任务";
    const countWrap = document.createElement("span");
    countWrap.className = "mt-count";
    const countNumber = document.createElement("span");
    countNumber.className = "mt-count-number";
    countNumber.textContent = String(count);
    if (this.previousCount >= 0 && count !== this.previousCount) countNumber.classList.add("is-rolling");
    countWrap.append(countNumber, " 项");
    this.previousCount = count;
    const spacer = document.createElement("span");
    spacer.className = "mt-spacer";
    const all = document.createElement("button");
    all.type = "button";
    all.className = "mt-head-button";
    all.textContent = allSelected ? "清空选择" : "全选";
    all.hidden = removables.length < 2;
    all.addEventListener("click", () => {
      if (allSelected) this.selected.clear();
      else this.selected = new Set(removables.map((item) => item.key));
      this.sync();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "mt-head-button mt-add";
    add.title = "添加文件或图片";
    add.setAttribute("aria-label", "添加材料");
    add.append(icon(Plus, { width: 14, height: 14, "stroke-width": 1.9, "aria-hidden": "true" }));
    add.addEventListener("click", () => this.opts.onAdd());
    const mention = document.createElement("button");
    mention.type = "button";
    mention.className = "mt-head-button mt-mention";
    mention.textContent = "@";
    mention.title = "加入标签页";
    mention.setAttribute("aria-label", "加入标签页");
    mention.addEventListener("click", () => this.opts.onMention());
    head.append(spacer, all, mention, add);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mt-head-button mt-toggle";
    toggle.setAttribute("aria-expanded", String(this.expanded));
    toggle.setAttribute("aria-label", this.expanded ? "收起材料" : "展开材料");
    toggle.append(folder, title, countWrap, icon(ChevronDown, { width: 14, height: 14, "aria-hidden": "true" }));
    toggle.addEventListener("click", () => { this.expanded = !this.expanded; this.sync(); });
    head.prepend(toggle);
    all.hidden = !this.expanded || removables.length < 2;

    const list = document.createElement("div");
    list.className = "mt-list";
    list.setAttribute("role", "list");
    list.hidden = !this.expanded;

    if (!count) {
      const empty = document.createElement("p");
      empty.className = "mt-empty";
      empty.textContent = "把文件拖进来，或在输入框用 @ 加入标签页";
      list.append(empty);
    }

    for (const item of this.materials) {
      list.append(this.renderRow(item));
    }

    shell.append(head, list);

    if (this.expanded && this.selected.size) {
      const actions = document.createElement("div");
      actions.className = "mt-actions";
      const copy = document.createElement("span");
      copy.className = "mt-selected-copy";
      copy.textContent = `${this.selected.size} 项已选`;
      const summary = document.createElement("button");
      summary.type = "button";
      summary.textContent = "复制摘要";
      summary.addEventListener("click", () => void this.copySummary());
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mt-remove";
      remove.textContent = `移出 ${this.selected.size} 项`;
      remove.addEventListener("click", () => this.removeSelected());
      actions.append(copy, summary, remove);
      shell.append(actions);
    }

    if (this.undo) {
      const undo = document.createElement("div");
      undo.className = "mt-undo";
      const text = document.createElement("span");
      text.textContent = this.undo.label;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "撤销";
      button.addEventListener("click", () => {
        const pending = this.undo;

        if (!pending) return;
        clearTimeout(pending.timer);
        this.undo = null;
        pending.restore();
        this.sync();
      });
      undo.append(text, button);
      shell.append(undo);
    }

    this.root.replaceChildren(...(draft ? [shell] : []));
    const delivery = this.delivery();

    // The "另开会话" and "还没有连接模型" cards in the conversation already state this rejection and offer the next step.
    if (delivery && !(delivery.receipt?.status === "rejected" && (delivery.receipt.newConversationRequest || delivery.receipt.needsModel))) {
      const receipt = delivery.receipt;
      const state = receipt?.status ?? "sending";
      const line = document.createElement("div");
      line.className = "mt-delivery";
      line.dataset.state = state;
      line.setAttribute("role", "status");
      const copy = document.createElement("span");
      copy.className = "mt-delivery-copy";
      copy.textContent = !receipt || state === "queued" ? "正在发送…" : state === "unknown" ? "尚未确认收到这条消息" : `未送达：${receipt.message}`;
      copy.title = copy.textContent;
      line.append(copy);

      if (receipt && (state === "failed" || state === "rejected" || state === "unknown")) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "mt-head-button";
        const canRetry = state !== "unknown" && !receipt.needsModel && !receipt.newConversationRequest;
        retry.textContent = canRetry ? "重试" : "查看详情";
        retry.addEventListener("click", () => {
          if (canRetry) this.opts.onRetry(delivery.request);
          else this.opts.onReceiptDetails(receipt);
        });
        line.append(retry);
      }
      this.root.append(line);
    }
  }

  private renderRow(item: TrayMaterial): HTMLElement {
    const row = document.createElement("div");
    row.className = "mt-row";
    row.dataset.kind = item.kind;
    row.dataset.state = item.state;
    row.setAttribute("role", "listitem");

    if (item.removable) {
      row.dataset.removable = "";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-pressed", String(this.selected.has(item.key)));
      row.classList.toggle("is-selected", this.selected.has(item.key));
      row.addEventListener("click", () => {
        if (this.selected.has(item.key)) this.selected.delete(item.key);
        else this.selected.add(item.key);
        this.sync();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        row.click();
      });
    } else {
      row.classList.add("is-fixed");
      row.title = "发送时会自动带上这一页";
    }

    const check = document.createElement("span");
    check.className = "mt-check";
    check.setAttribute("aria-hidden", "true");
    if (item.removable) check.textContent = "✓";

    const glyph = document.createElement("span");
    glyph.className = "mt-glyph";

    if (item.kind === "page" && item.tabId !== undefined) {
      const page = item.key.startsWith("mention:")
        ? this.opts.mentions().find((mention) => mention.tabId === item.tabId)
        : this.opts.selection() ?? this.opts.page();
      const url = page && "url" in page ? page.url : "";
      const mark = siteGlyph(url, hostOf(url) || item.label);
      mark.classList.add("mt-site-glyph");
      glyph.append(mark);
    } else {
      glyph.append(icon(item.kind === "selection" ? TextQuote : item.kind === "page" ? Globe2 : FileText, {
        width: 15,
        height: 15,
        "stroke-width": 1.8,
        "aria-hidden": "true",
      }));
    }

    const copy = document.createElement("span");
    copy.className = "mt-copy";
    const label = document.createElement("strong");
    label.textContent = item.label;
    label.title = item.label;
    const detail = document.createElement("span");
    detail.textContent = item.detail;
    copy.append(label, detail);

    const state = document.createElement("span");
    state.className = "mt-state";
    state.textContent = item.status;

    row.append(check, glyph, copy, state);

    return row;
  }

  private removeSelected(): void {
    const picked = this.materials.filter((item) => item.removable && this.selected.has(item.key));

    if (!picked.length) return;
    const removals = picked.map((item): TrayRemoval => {
      if (item.kind === "selection") return { kind: "selection", key: item.key, tabId: item.tabId };
      if (item.attachmentId) return { kind: "attachment", key: item.key, attachmentId: item.attachmentId };

      return { kind: "mention", key: item.key, tabId: item.tabId };
    });
    const restore = this.opts.onRemove(removals);

    this.selected.clear();
    if (restore) {
      if (this.undo) clearTimeout(this.undo.timer);
      const timer = setTimeout(() => {
        this.undo = null;
        this.sync();
      }, 5_200);
      this.undo = { label: `已移出 ${removals.length} 项`, restore, timer };
    }
    this.sync();
  }

  private async copySummary(): Promise<void> {
    const selected = this.materials.filter((item) => this.selected.has(item.key));
    const text = selected.map((item) => `${item.label}\n${item.detail}`).join("\n\n");

    try {
      await navigator.clipboard.writeText(text);
      this.showNote("摘要已复制");
    } catch {
      this.showNote("复制失败，请重试");
    }
  }

  private showNote(text: string): void {
    const existing = this.root.querySelector(".mt-note");

    if (existing) existing.remove();
    const note = document.createElement("span");
    note.className = "mt-note";
    note.setAttribute("role", "status");
    note.textContent = text;
    this.root.append(note);
    setTimeout(() => note.remove(), 1_800);
  }
}
