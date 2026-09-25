/**
 * 模型写给用户的文件（artifacts 工具）在侧栏里的卡片：文件名、类型与大小、一个「下载」按钮。
 * 同名文件再次保存时更新同一张卡片；删除后卡片保留但标明已删除、不能再下载。
 */
import type { AgentUiEvent } from "../../../shared/protocol.js";

type ArtifactEvent = Extract<AgentUiEvent, { kind: "artifact" }>;

const MIME = {
  csv: "text/csv", md: "text/markdown", txt: "text/plain", json: "application/json",
  html: "text/html", htm: "text/html", svg: "image/svg+xml", js: "text/javascript", css: "text/css",
} satisfies Record<string, string>;

const KIND_LABEL = { csv: "表格", md: "文档", txt: "文本", json: "数据", html: "网页", htm: "网页", svg: "图片", js: "脚本", css: "样式" } satisfies Record<string, string>;

const lookup = (table: Record<string, string>, ext: string): string | undefined => (Object.hasOwn(table, ext) ? table[ext] : undefined);

const extensionOf = (filename: string) => filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();

function sizeLabel(content: string): string {
  const bytes = new TextEncoder().encode(content).length;

  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** CSV 前加 BOM：Excel 按 UTF-8 打开，中文不乱码。 */
function download(filename: string, content: string): void {
  const ext = extensionOf(filename);
  const body = ext === "csv" ? `\uFEFF${content}` : content;
  const url = URL.createObjectURL(new Blob([body], { type: `${lookup(MIME, ext) ?? "text/plain"};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class ArtifactCards {
  private readonly cards = new Map<string, { root: HTMLElement; meta: HTMLElement; button: HTMLButtonElement; content: string }>();
  /** 本轮新建或改过的卡片：回合结束时挪到回答下面，用户读完回答就能看到。 */
  private readonly touched = new Set<string>();

  constructor(private readonly append: (el: HTMLElement) => void) {}

  apply(event: ArtifactEvent): void {
    const existing = this.cards.get(event.filename);

    if (event.action === "deleted") {
      if (!existing) return;
      existing.root.dataset.deleted = "true";
      existing.meta.textContent = "已删除";
      existing.button.disabled = true;

      return;
    }

    const content = event.content ?? "";
    const card = existing ?? this.create(event.filename);
    this.touched.add(event.filename);
    card.content = content;
    card.root.dataset.deleted = "false";
    card.button.disabled = false;
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifact-download";
    button.textContent = "下载";
    button.title = `下载 ${filename}`;
    const card = { root, meta, button, content: "" };
    button.addEventListener("click", () => download(filename, card.content));
    root.append(info, button);
    this.cards.set(filename, card);
    this.append(root);

    return card;
  }
}
