/**
 * 模型写给用户的文件（artifacts 工具）在侧栏里的卡片：文件名、类型与大小、「打开」与「下载」按钮。
 * 同名文件再次保存时更新同一张卡片；删除后卡片保留但标明已删除、不能再打开或下载。
 * 「打开」把内容放进 chrome.storage.session，再在新标签页开查看页（artifact-viewer-page.ts）；
 * 之后同名再保存或删除时同步这份副本，已开的查看页跟着更新或提示文件已不在。
 */
import type { AgentUiEvent } from "../../../shared/protocol.js";

type ArtifactEvent = Extract<AgentUiEvent, { kind: "artifact" }>;

const MIME = {
  csv: "text/csv", md: "text/markdown", txt: "text/plain", json: "application/json",
  html: "text/html", htm: "text/html", svg: "image/svg+xml", js: "text/javascript", css: "text/css",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
} satisfies Record<string, string>;

const KIND_LABEL = { csv: "表格", md: "文档", txt: "文本", json: "数据", html: "网页", htm: "网页", svg: "图片", js: "脚本", css: "样式" } satisfies Record<string, string>;

export const lookup = (table: Record<string, string>, ext: string): string | undefined => (Object.hasOwn(table, ext) ? table[ext] : undefined);

export const extensionOf = (filename: string) => filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();

function sizeLabel(content: string): string {
  const bytes = new TextEncoder().encode(content).length;

  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

export const mimeOf = (filename: string): string => lookup(MIME, extensionOf(filename)) ?? "text/plain";

/** 查看页读的副本：chrome.storage.session 里的一项，键随卡片固定。 */
export type ArtifactViewItem = { filename: string; content: string };

export const VIEW_KEY_PREFIX = "artifactView:";

/** CSV 前加 BOM：Excel 按 UTF-8 打开，中文不乱码。 */
export function download(filename: string, content: string): void {
  const ext = extensionOf(filename);
  const body = ext === "csv" ? `\uFEFF${content}` : content;
  const url = URL.createObjectURL(new Blob([body], { type: `${mimeOf(filename)};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class ArtifactCards {
  private readonly cards = new Map<string, { root: HTMLElement; meta: HTMLElement; buttons: HTMLButtonElement[]; content: string; viewKey: string; opened: boolean }>();
  /** 本轮新建或改过的卡片：回合结束时挪到回答下面，用户读完回答就能看到。 */
  private readonly touched = new Set<string>();

  constructor(private readonly append: (el: HTMLElement) => void) {}

  apply(event: ArtifactEvent): void {
    const existing = this.cards.get(event.filename);

    if (event.action === "deleted") {
      if (!existing) return;
      existing.root.dataset.deleted = "true";
      existing.meta.textContent = "已删除";

      for (const button of existing.buttons) button.disabled = true;

      if (existing.opened) void chrome.storage.session.remove(existing.viewKey);

      return;
    }

    const content = event.content ?? "";
    const card = existing ?? this.create(event.filename);
    this.touched.add(event.filename);
    card.content = content;
    card.root.dataset.deleted = "false";

    for (const button of card.buttons) button.disabled = false;

    if (card.opened) void this.share(event.filename, card);
    card.meta.textContent = `${lookup(KIND_LABEL, extensionOf(event.filename)) ?? "文件"} · ${sizeLabel(content)}`;
  }

  /** 回合结束：把本轮动过的卡片按原顺序挪到消息流末尾（回答之后）。 */
  settleAfterTurn(): void {
    for (const filename of this.touched) {
      const card = this.cards.get(filename);

      if (card) this.append(card.root);
    }

    this.touched.clear();
  }

  private create(filename: string) {
    const root = document.createElement("div");
    root.className = "artifact-card";
    root.dataset.filename = filename;
    const info = document.createElement("div");
    info.className = "artifact-info";
    const name = document.createElement("div");
    name.className = "artifact-name";
    name.textContent = filename;
    const meta = document.createElement("div");
    meta.className = "artifact-meta";
    info.append(name, meta);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "artifact-open";
    open.textContent = "打开";
    open.title = `在新标签页打开 ${filename}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifact-download";
    button.textContent = "下载";
    button.title = `下载 ${filename}`;
    const card = { root, meta, buttons: [open, button], content: "", viewKey: `${VIEW_KEY_PREFIX}${crypto.randomUUID()}`, opened: false };
    open.addEventListener("click", () => void this.open(filename, card));
    button.addEventListener("click", () => download(filename, card.content));
    root.append(info, open, button);
    this.cards.set(filename, card);
    this.append(root);

    return card;
  }

  private share(filename: string, card: { content: string; viewKey: string }): Promise<void> {
    const item: ArtifactViewItem = { filename, content: card.content };

    return chrome.storage.session.set({ [card.viewKey]: item });
  }

  /** 先写好副本再开标签页：查看页一加载就能读到。 */
  private async open(filename: string, card: { content: string; viewKey: string; opened: boolean }): Promise<void> {
    await this.share(filename, card);
    card.opened = true;
    const id = card.viewKey.slice(VIEW_KEY_PREFIX.length);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`artifact-viewer.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`) });
  }
}
