/**
 * 生成文件的查看页（新标签页，扩展页面）：按文件类型显示侧栏卡片「打开」的那份文件。
 * 网页放进 manifest 沙箱页（不透明来源、无 chrome.* 接口），脚本能跑但碰不到扩展；
 * Markdown 用侧栏同一个渲染器并消毒；图片与 PDF 用本页生成的 blob 地址（截图是 base64，先还原成字节）；其余文本原样等宽显示。
 * 内容来自 chrome.storage.session 里侧栏写的副本；副本被删（文件已删除）时显示「文件已不在了」。
 */
import DOMPurify from "dompurify";
import { bytesOf, download, extensionOf, lookup, mimeOf, VIEW_KEY_PREFIX, type ArtifactViewItem } from "./artifact-card.js";
import { renderMarkdownHtml } from "./markdown.js";

const params = new URLSearchParams(location.search);

const key = `${VIEW_KEY_PREFIX}${params.get("id") ?? ""}`;

const filename = params.get("name") ?? "文件";

const view = document.getElementById("view")!;

const downloadButton = document.querySelector<HTMLButtonElement>("#download")!;

const KIND = { html: "网页", htm: "网页", md: "Markdown", csv: "表格", json: "数据", txt: "文本", svg: "图片", png: "图片", jpg: "图片", jpeg: "图片", gif: "图片", webp: "图片", pdf: "PDF" } satisfies Record<string, string>;

const IMAGE = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp"]);

let current: ArtifactViewItem | null = null;

let blobUrl: string | null = null;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const ext = extensionOf(filename);

document.title = filename;

document.getElementById("name")!.textContent = filename;

document.getElementById("kind")!.textContent = lookup(KIND, ext) ?? "文件";

downloadButton.addEventListener("click", () => {
  if (current) download(current.filename, current.content, current.encoding);
});

function blobOf(content: string, encoding?: "base64"): string {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(new Blob([encoding === "base64" ? bytesOf(content) : content], { type: mimeOf(filename) }));

  return blobUrl;
}

/** 网页：不带 allow-same-origin 的沙箱 iframe 加载 manifest 沙箱页，等它说 ready 再把正文发过去。 */
function renderHtml(content: string): HTMLElement {
  const frame = document.createElement("iframe");
  frame.className = "frame";
  frame.title = filename;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals");

  const onReady = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    window.removeEventListener("message", onReady);
    frame.contentWindow?.postMessage({ html: content }, "*");
  };

  window.addEventListener("message", onReady);
  frame.src = "artifact-sandbox.html";

  return frame;
}

function renderContent({ content, encoding }: ArtifactViewItem): HTMLElement {
  if (ext === "html" || ext === "htm") return renderHtml(content);

  if (ext === "md") {
    const article = document.createElement("article");
    article.className = "doc";
    article.innerHTML = DOMPurify.sanitize(renderMarkdownHtml(content));

    return article;
  }

  if (IMAGE.has(ext)) {
    const box = document.createElement("div");
    box.className = "image";
    const img = document.createElement("img");
    img.alt = filename;
    img.src = blobOf(content, encoding);
    box.append(img);

    return box;
  }

  if (ext === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "frame";
    frame.title = filename;
    frame.src = blobOf(content, encoding);

    return frame;
  }

  const pre = document.createElement("pre");
  pre.className = "text";
  pre.textContent = content;

  return pre;
}

function render(item: ArtifactViewItem | undefined): void {
  current = item ?? null;
  downloadButton.hidden = !item;

  if (!item) {
    const missing = document.createElement("div");
    missing.className = "missing";
    const title = document.createElement("strong");
    title.textContent = "文件已不在了";
    const hint = document.createElement("div");
    hint.textContent = "它可能已在对话里被删除，或浏览器重启后清掉了。回到侧栏让助手重新生成即可。";
    missing.append(title, hint);
    view.replaceChildren(missing);

    return;
  }

  view.replaceChildren(renderContent(item));
}

const isItem = (value: unknown): value is ArtifactViewItem =>
  typeof value === "object" && value !== null && "content" in value && typeof value.content === "string" && "filename" in value && typeof value.filename === "string";

chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[key];

  if (!change) return;
  const next: unknown = change.newValue;
  render(isItem(next) ? next : undefined);
});

const stored: unknown = (await chrome.storage.session.get(key))[key];

render(isItem(stored) ? stored : undefined);
