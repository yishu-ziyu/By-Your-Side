import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";
import * as pdfWorker from "pdfjs-dist/build/pdf.worker.mjs";

/**
 * WHY: Chrome 的 PDF 阅读器是另一个扩展的页面：无障碍树里只有工具栏，没有正文，调试器也进不去。
 * 所以 PDF 正文由本扩展自己用 pdf.js 解析。服务工作线程里不能开 Worker，pdf.js 认 globalThis.pdfjsWorker 在本线程里跑。
 */
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

const PDF_TEXT_BUDGET = 14_000;
const OUTLINE_MAX = 40;
const PDF_MAX_BYTES = 150 * 1024 * 1024;

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

const cache = new Map<number, { url: string; task: PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy> }>();

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
  const head = await fetch(url, { method: "HEAD", credentials: "include", signal: AbortSignal.timeout(5_000) }).catch(() => null);
  const size = head?.ok ? Number(head.headers.get("content-length") ?? 0) : 0;

  if (generation.get(tabId) !== version) throw new Error("读取期间页面已刷新或关闭，请重新读取当前页面");

  if (size > PDF_MAX_BYTES) throw new Error(`这份 PDF 有 ${Math.round(size / 1024 / 1024)} MB，超过 ${PDF_MAX_BYTES / 1024 / 1024} MB，没有解析`);
  const data = size > 0 ? undefined : await downloadCapped(url);

  if (generation.get(tabId) !== version) throw new Error("读取期间页面已刷新或关闭，请重新读取当前页面");
  const task = getDocument({
    ...(data ? { data } : { url: new URL(url) }), disableAutoFetch: true, disableStream: true, withCredentials: true, useWorkerFetch: false,
    cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"), cMapPacked: true, BinaryDataFactory: ExtensionBinaryDataFactory,
  });
  const doc = task.promise;
  cache.set(tabId, { url, task, doc });
  doc.catch(() => { if (cache.get(tabId)?.doc === doc) cache.delete(tabId); });

  return doc;
}

async function downloadCapped(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(60_000) });

  if (!response.ok || !response.body) throw new Error(`下载 PDF 失败（${response.status}）`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    total += value.byteLength;

    if (total > PDF_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`这份 PDF 超过 ${PDF_MAX_BYTES / 1024 / 1024} MB，没有解析`);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) { data.set(chunk, at); at += chunk.byteLength; }

  return data;
}

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
    } catch {  }

    lines.push(`- ${item.title.trim()}${page ? `（第 ${page} 页）` : ""}`);
  }

  return lines;
}

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
