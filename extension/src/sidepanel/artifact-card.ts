/**
 * 模型写给用户的文件（artifacts 工具）在侧栏里的卡片：文件名、类型与大小、「打开」与「下载」按钮。
 * 模型交给用户的截图（encoding: base64 的 PNG）同样是一张卡片，上方直接显示图片，点图片与「打开」一样看大图。
 * 同名文件再次保存时更新同一张卡片；删除后卡片保留但标明已删除、不能再打开或下载。
 * 「打开」把内容放进 chrome.storage.session，再在新标签页开查看页（artifact-viewer-page.ts）；
 * 之后同名再保存或删除时同步这份副本，已开的查看页跟着更新或提示文件已不在。
 */
import { readArtifact } from "../shared/durable-store.js";
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

/** base64 → 字节；截图卡片的下载与查看页的图片都用原始字节。 */
export function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);

  return out;
}

function sizeLabel(content: string, encoding?: "base64"): string {
  const bytes = encoding === "base64" ? Math.floor((content.length * 3) / 4) - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0) : new TextEncoder().encode(content).length;

  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

export const mimeOf = (filename: string): string => lookup(MIME, extensionOf(filename)) ?? "text/plain";

/** 查看页读的副本：chrome.storage.session 里的一项，键随卡片固定。 */
export type ArtifactViewItem = { filename: string; content: string; encoding?: "base64" };

export const VIEW_KEY_PREFIX = "artifactView:";

/** CSV 前加 BOM：Excel 按 UTF-8 打开，中文不乱码。base64 内容（截图）按原始字节下载。 */
export function download(filename: string, content: string, encoding?: "base64"): void {
  const ext = extensionOf(filename);

  const body = encoding === "base64" ? new Blob([bytesOf(content)], { type: mimeOf(filename) })
    : new Blob([ext === "csv" ? `\uFEFF${content}` : content], { type: `${mimeOf(filename)};charset=utf-8` });

  const url = URL.createObjectURL(body);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Card = { root: HTMLElement; meta: HTMLElement; buttons: HTMLButtonElement[]; content: string; encoding?: "base64"; viewKey: string; opened: boolean; previewToggle: HTMLButtonElement };

export class ArtifactCards {
  private readonly cards = new Map<string, Card>();
  /** 本轮新建或改过的卡片：回合结束时挪到回答下面，用户读完回答就能看到。 */
  private readonly touched = new Set<string>();

  private generation = 0;
  reset(): void { this.generation += 1; this.cards.clear(); this.touched.clear(); this.revisions.clear(); }
  private readonly revisions = new Map<string, number>();
  constructor(private readonly append: (el: HTMLElement) => void, private readonly conversation: () => string = () => "default") {}

  apply(event: ArtifactEvent): void {
    const revision = (this.revisions.get(event.filename) ?? 0)+1;
    this.revisions.set(event.filename,revision);
    const conversation = this.conversation(), generation = this.generation;

    if(event.action === "saved" && event.content === undefined) {
      void readArtifact(conversation,event.filename).then(item => {
        if(this.generation !== generation || this.conversation() !== conversation || this.revisions.get(event.filename) !== revision)return;

        if(item)this.apply({...event,...item});
      }).catch(error => console.error("文件读取失败",error));

      return;
    }

    const existing = this.cards.get(event.filename);

    if (event.action === "deleted") {
      if (!existing) return;
      existing.root.dataset.deleted = "true";
      existing.meta.textContent = "已删除";

      for (const button of existing.buttons) button.disabled = true;

      existing.root.querySelector(".artifact-preview")?.remove();
      existing.root.dataset.kind = "file";
      existing.previewToggle.hidden = true;

      if (existing.opened) void chrome.storage.session.remove(existing.viewKey);

      return;
    }

    const content = event.content ?? "";
    const card = existing ?? this.create(event.filename);
    this.touched.add(event.filename);
    card.content = content;
    card.encoding = event.encoding;
    card.root.dataset.deleted = "false";
    this.preview(card);

    for (const button of card.buttons) button.disabled = false;

    if (card.opened) void this.share(event.filename, card);
    card.meta.textContent = `${event.encoding === "base64" ? "图片" : lookup(KIND_LABEL, extensionOf(event.filename)) ?? "文件"} · ${sizeLabel(content, event.encoding)}`;
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
    const previewToggle = document.createElement("button");
    previewToggle.type = "button";
    previewToggle.className = "artifact-preview-toggle";
    previewToggle.textContent = "展开";
    previewToggle.setAttribute("aria-expanded", "false");
    previewToggle.hidden = true;
    const card: Card = { root, meta, previewToggle, buttons: [open, button, previewToggle], content: "", viewKey: `${VIEW_KEY_PREFIX}${crypto.randomUUID()}`, opened: false };
    open.addEventListener("click", () => void this.open(filename, card));
    button.addEventListener("click", () => download(filename, card.content, card.encoding));
    previewToggle.addEventListener("click", () => {
      const expanded = root.dataset.expanded !== "true";
      root.dataset.expanded = String(expanded);
      previewToggle.setAttribute("aria-expanded", String(expanded));
      previewToggle.textContent = expanded ? "收起" : "展开";
    });
    root.append(info, open, button, previewToggle);
    this.cards.set(filename, card);
    this.append(root);

    return card;
  }

  /** 默认缩略图保留文件名与操作；展开用同一原图，不调用模型。点图打开查看页。 */
  private preview(card: Card): void {
    const old = card.root.querySelector<HTMLImageElement>(".artifact-preview");
    card.previewToggle.hidden = card.encoding !== "base64";

    if (card.encoding !== "base64") {
      old?.remove();
      card.root.dataset.kind = "file";

      return;
    }

    const filename = card.root.dataset.filename ?? "";
    card.root.dataset.kind = "image";
    const img = old ?? document.createElement("img");
    img.className = "artifact-preview";
    img.alt = filename;
    img.title = "点击查看大图";
    img.src = `data:${mimeOf(filename)};base64,${card.content}`;

    if (!old) {
      img.addEventListener("click", () => void this.open(filename, card));
      card.root.prepend(img);
    }
  }

  private share(filename: string, card: Card): Promise<void> {
    const item: ArtifactViewItem = card.encoding ? { filename, content: card.content, encoding: card.encoding } : { filename, content: card.content };

    return chrome.storage.session.set({ [card.viewKey]: item });
  }

  /** 先写好副本再开标签页：查看页一加载就能读到。 */
  private async open(filename: string, card: Card): Promise<void> {
    await this.share(filename, card);
    card.opened = true;
    const id = card.viewKey.slice(VIEW_KEY_PREFIX.length);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`artifact-viewer.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`) });
  }
}
