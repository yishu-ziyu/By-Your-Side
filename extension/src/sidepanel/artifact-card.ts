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

type Card = {
  root: HTMLElement;
  meta: HTMLElement;
  buttons: HTMLButtonElement[];
  content: string;
  encoding?: "base64";
  viewKey: string;
  opened: boolean;
  previewToggle: HTMLButtonElement;
  inlineToggle: HTMLButtonElement;
  inlineRoot: HTMLElement;
  detachInline?: () => void;
};

export class ArtifactCards {
  private readonly cards = new Map<string, Card>();
  /** 本轮新建或改过的卡片：回合结束时挪到回答下面，用户读完回答就能看到。 */
  private readonly touched = new Set<string>();

  private generation = 0;
  reset(): void {
    this.generation += 1;

    for (const card of this.cards.values()) this.closeInline(card);

    this.cards.clear(); this.touched.clear(); this.revisions.clear();
  }
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly append: (el: HTMLElement) => void,
    private readonly conversation: () => string = () => "default",
    /** 必须再次由用户点按钮，才把沙箱里的选择填进草稿；永不自动发送。 */
    private readonly onChoice: (text: string) => void = (text) => {
      const input = document.querySelector<HTMLTextAreaElement>("#input");

      if (!input) return;
      input.value = [input.value.trim(), `我选择：${text}`].filter(Boolean).join("\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    },
  ) {}

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
      this.closeInline(existing);
      existing.root.dataset.deleted = "true";
      existing.meta.textContent = "已删除";

      for (const button of existing.buttons) button.disabled = true;

      existing.root.querySelector(".artifact-preview")?.remove();
      existing.root.dataset.kind = "file";
      existing.previewToggle.hidden = true;
      existing.inlineToggle.hidden = true;

      if (existing.opened) void chrome.storage.session.remove(existing.viewKey);

      return;
    }

    const content = event.content ?? "";
    const card = existing ?? this.create(event.filename);
    this.touched.add(event.filename);
    const contentChanged = card.content !== content || card.encoding !== event.encoding;
    card.content = content;
    card.encoding = event.encoding;
    card.root.dataset.deleted = "false";
    this.preview(card, contentChanged);

    for (const button of card.buttons) button.disabled = false;

    if (card.opened) void this.share(event.filename, card);
    card.meta.textContent = `${event.encoding === "base64" ? "图片" : lookup(KIND_LABEL, extensionOf(event.filename)) ?? "文件"} · ${sizeLabel(content, event.encoding)}`;
  }

  /** 回合结束卡片在回答之后。已展开的 iframe 必须保持连接，排列方式由 append callback 决定。 */
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
    const inlineToggle = document.createElement("button");
    inlineToggle.type = "button";
    inlineToggle.className = "artifact-inline-toggle";
    inlineToggle.textContent = "交互预览";
    inlineToggle.setAttribute("aria-expanded", "false");
    inlineToggle.hidden = true;
    const inlineRoot = document.createElement("div");
    inlineRoot.className = "artifact-inline-root";
    inlineRoot.hidden = true;
    const card: Card = { root, meta, previewToggle, inlineToggle, inlineRoot,
      buttons: [open, button, previewToggle, inlineToggle], content: "",
      viewKey: `${VIEW_KEY_PREFIX}${crypto.randomUUID()}`, opened: false };
    open.addEventListener("click", () => void this.open(filename, card));
    button.addEventListener("click", () => download(filename, card.content, card.encoding));
    inlineToggle.addEventListener("click", () => {
      if (card.inlineRoot.hidden) this.openInline(card);
      else this.closeInline(card);
    });
    previewToggle.addEventListener("click", () => {
      const expanded = root.dataset.expanded !== "true";
      root.dataset.expanded = String(expanded);
      previewToggle.setAttribute("aria-expanded", String(expanded));
      previewToggle.textContent = expanded ? "收起" : "展开";
    });
    root.append(info, open, button, inlineToggle, previewToggle, inlineRoot);
    this.cards.set(filename, card);
    this.append(root);

    return card;
  }

  /** 默认缩略图保留文件名与操作；展开用同一原图，不调用模型。点图打开查看页。 */
  private preview(card: Card, contentChanged: boolean): void {
    const old = card.root.querySelector<HTMLImageElement>(".artifact-preview");
    card.previewToggle.hidden = card.encoding !== "base64";
    const html = card.encoding !== "base64" && ["html", "htm"].includes(extensionOf(card.root.dataset.filename ?? ""));
    const live = html && !card.inlineRoot.hidden;

    if (live && contentChanged && !card.inlineRoot.querySelector(".artifact-inline-stale")) {
      // HTML changed during this turn. Keep the running iframe and user input.
      // Loading the new version is an explicit decision (close and reopen).
      const notice = document.createElement("p");
      notice.className = "artifact-inline-stale";
      notice.textContent = "文件已更新。当前预览保留填写内容；收起后重新展开可查看新版。";
      card.inlineRoot.appendChild(notice);
    }

    if (!live) this.closeInline(card);
    card.inlineToggle.hidden = !html;

    if (card.encoding !== "base64") {
      old?.remove();
      card.root.dataset.kind = html ? "interactive-html" : "file";

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

  /** 只有主动展开才装入脚本；回传只准备本地草稿，不触发模型或网页动作。 */
  private openInline(card: Card): void {
    if (card.encoding || !["html", "htm"].includes(extensionOf(card.root.dataset.filename ?? ""))) return;
    this.closeInline(card);
    const frame = document.createElement("iframe");
    frame.className = "artifact-inline-frame";
    frame.title = `${card.root.dataset.filename ?? "网页"} · 独立交互预览`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    const feedback = document.createElement("div");
    feedback.className = "artifact-inline-feedback";
    feedback.hidden = true;
    const choice = document.createElement("span");
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "artifact-apply-choice";
    apply.textContent = "填入输入框";
    let selected = "";
    apply.addEventListener("click", () => {
      if (!selected) return;
      this.onChoice(selected);
      apply.textContent = "已填入";
      apply.disabled = true;
    });
    feedback.append(choice, apply);
    card.inlineRoot.replaceChildren(frame, feedback);
    card.inlineRoot.hidden = false;
    card.inlineToggle.textContent = "收起预览";
    card.inlineToggle.setAttribute("aria-expanded", "true");
    let ready = false;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      const data = event.data;

      if (!data || typeof data !== "object") return;

      if ("artifactSandbox" in data && data.artifactSandbox === "ready") {
        if (ready) return;
        ready = true;
        frame.contentWindow?.postMessage({ html: card.content }, "*");

        return;
      }

      if (!("sideagentResultChoice" in data) || data.sideagentResultChoice !== 1 ||
        !("label" in data) || typeof data.label !== "string" || data.label.length > 120) return;
      selected = data.label.replace(/\s+/g, " ").trim();

      if (!selected) return;
      choice.textContent = `已选：${selected}`;
      feedback.hidden = false;
      apply.textContent = "填入输入框";
      apply.disabled = false;
    };
    window.addEventListener("message", onMessage);
    card.detachInline = () => {
      window.removeEventListener("message", onMessage);
      frame.remove();
    };
    frame.src = chrome.runtime.getURL("artifact-sandbox.html");
  }

  private closeInline(card: Card): void {
    card.detachInline?.();
    card.detachInline = undefined;
    card.inlineRoot.replaceChildren();
    card.inlineRoot.hidden = true;
    card.inlineToggle.textContent = "交互预览";
    card.inlineToggle.setAttribute("aria-expanded", "false");
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
