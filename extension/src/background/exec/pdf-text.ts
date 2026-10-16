import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.mjs";

/**
 * Chrome 的 PDF 阅读器是另一个扩展的页面：无障碍树里只有工具栏，没有正文，调试器也进不去。
 * 所以 PDF 正文由本扩展自己用 pdf.js 解析。服务工作线程里不能开 Worker，pdf.js 认 globalThis.pdfjsWorker 在本线程里跑。
 */
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

/** 一次交给模型的正文上限；与普通页面的读页预算同一量级。 */
const PDF_TEXT_BUDGET = 14_000;
const OUTLINE_MAX = 40;
/** pdf.js 按文件长度一次分配内存：超过这个大小不解析，免得拖垮整个扩展后台。 */
const PDF_MAX_BYTES = 150 * 1024 * 1024;

/**
 * 中文、日文 PDF 的字符映射表随扩展打包。pdf.js 自带的取法要读 document.baseURI，服务工作线程里没有，所以自己取。
 * 形状照 pdf.js 的 BinaryDataFactory：构造时收各类资源的地址前缀，fetch 按类别和文件名取字节。
 */
class ExtensionBinaryDataFactory {
  private readonly bases: Record<string, string | null>;

  constructor({ cMapUrl = null }: { cMapUrl?: string | null }) {
    this.bases = { cMapUrl };
  }

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = this.bases[kind];

    if (!base) throw new Error(`PDF 需要的 ${kind} 资源没有打包`);
    const response = await fetch(`${base}${filename}`);

    if (!response.ok) throw new Error(`读不到 PDF 资源 ${filename}`);

    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * 翻页时不重下同一份 PDF。按标签页存：别的标签页读另一份 PDF 不会中断这一份；
 * 标签页重新加载（含换账号后刷新）或关闭就丢掉，不把一个登录身份读到的内容给下一次用。
 */
const cache = new Map<number, { url: string; task: PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy> }>();

/** 每个标签页的页面版本：刷新或关闭就加一，等大小检查回来时用它判断这次读取是否已经作废。 */
const generation = new Map<number, number>();

function forget(tabId: number) {
  generation.set(tabId, (generation.get(tabId) ?? 0) + 1);
  void cache.get(tabId)?.task.destroy();
  cache.delete(tabId);
}

chrome.tabs.onRemoved.addListener(tabId => { forget(tabId); generation.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "loading") forget(tabId); });

async function openPdf(tabId: number, url: string): Promise<PDFDocumentProxy> {
  const hit = cache.get(tabId);

  if (hit?.url === url) return hit.doc;
  forget(tabId);
  const version = generation.get(tabId);
  // 先问大小；对方不答大小或不支持 HEAD 时照常读（标签页里的阅读器已经下过这份文件），只挡住明确超大的。
  const head = await fetch(url, { method: "HEAD", credentials: "include", signal: AbortSignal.timeout(5_000) }).catch(() => null);
  const size = Number(head?.headers.get("content-length") ?? 0);

  if (generation.get(tabId) !== version) throw new Error("读取期间页面已刷新或关闭，请重新读取当前页面");

  if (size > PDF_MAX_BYTES) throw new Error(`这份 PDF 有 ${Math.round(size / 1024 / 1024)} MB，超过 ${PDF_MAX_BYTES / 1024 / 1024} MB，没有解析`);
  // 大报告动辄几十兆：只按需取用到的那几段，不整份下载。
  // 传 URL 对象、关掉 useWorkerFetch：字符串地址和资源的默认取法都会去读 window / document，服务工作线程里没有。
  const task = getDocument({
    url: new URL(url), disableAutoFetch: true, disableStream: true, withCredentials: true, useWorkerFetch: false,
    cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"), cMapPacked: true, BinaryDataFactory: ExtensionBinaryDataFactory,
  });
  const doc = task.promise;
  cache.set(tabId, { url, task, doc });
  doc.catch(() => { if (cache.get(tabId)?.doc === doc) cache.delete(tabId); });

  return doc;
}

/** 这个标签页显示的是 PDF 吗：看文档类型，不看地址后缀（很多 PDF 地址不以 .pdf 结尾）。 */
export async function tabShowsPdf(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, world: "ISOLATED", func: () => document.contentType });

    return result?.result === "application/pdf";
  } catch {
    return false;
  }
}

async function outlineLines(doc: PDFDocumentProxy): Promise<string[]> {
  const outline = await doc.getOutline().catch(() => null);
  const lines: string[] = [];

  for (const item of outline ?? []) {
    if (lines.length >= OUTLINE_MAX) break;
    let page: number | null = null;

    try {
      const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      const ref = dest?.[0];

      if (ref && typeof ref === "object") page = (await doc.getPageIndex(ref)) + 1;
      else if (typeof ref === "number") page = ref + 1;
    } catch { /* 目录项没有可解析的页码时只列标题 */ }

    lines.push(`- ${item.title.trim()}${page ? `（第 ${page} 页）` : ""}`);
  }

  return lines;
}

/**
 * 读 PDF 的正文：文档信息、目录（带页码）、从 #page=N 那页起的若干页文字。
 * 读不完时告诉模型怎么翻到后面：地址加 #page=N，这也是 Chrome 阅读器自己认的写法，用户看到的就是那一页。
 */
export async function pdfText(tabId: number, url: string): Promise<string> {
  const file = url.replace(/#.*$/, "");
  const doc = await openPdf(tabId, file);
  const start = Math.min(Math.max(Number(/#(?:.*&)?page=(\d+)/.exec(url)?.[1]) || 1, 1), doc.numPages);
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const field = (key: string) => (typeof info[key] === "string" && (info[key] as string).trim()) || "";
  const head = [`[PDF 文档，共 ${doc.numPages} 页。没有元素编号；正文由 PDF 文件解析，不是截图识别。]`];

  if (field("Title")) head.push(`标题：${field("Title")}`);
  if (field("Author")) head.push(`文档作者字段：${field("Author")}`);
  if (field("CreationDate")) head.push(`文件创建时间：${field("CreationDate").replace(/^D:(\d{4})(\d{2})?(\d{2})?.*$/, (_, y, m, d) => [y, m, d].filter(Boolean).join("-"))}`);

  if (start === 1) {
    const outline = await outlineLines(doc);

    if (outline.length) head.push("目录：", ...outline);
  }

  const pages: string[] = [];
  let used = head.join("\n").length;
  let page = start;
  let cutPage: number | null = null;

  for (; page <= doc.numPages && used < PDF_TEXT_BUDGET; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    const text = content.items.map(item => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const block = `--- 第 ${page} 页 ---\n${text || "（这一页没有可提取的文字，可能是图片）"}`;
    const room = PDF_TEXT_BUDGET - used;

    if (block.length > room) cutPage = page;
    pages.push(block.slice(0, room));
    used += block.length;
  }

  const shownEnd = page - 1;
  const tail = cutPage !== null
    ? `[第 ${cutPage} 页太长，只给了前一部分。${cutPage < doc.numPages ? `要读第 N 页起的文字，navigate 到 ${file}#page=N 再读页。` : ""}]`
    : shownEnd < doc.numPages
      ? `[以上是第 ${start}–${shownEnd} 页。要读第 N 页起的文字，navigate 到 ${file}#page=N 再读页。]`
      : `[以上读到最后一页（第 ${doc.numPages} 页）。]`;

  return [...head, ...pages, tail].join("\n");
}
