/**
 * PDF 读成文字；没有文字层的页（扫描件、截图拼的 PDF）画成图，交给模型自己看。
 * pdf.js 的解析在它自己的 Worker 里跑（pdf.worker.mjs 随扩展打包），侧栏界面不卡。
 */
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentProxy } from "pdfjs-dist";
import { FILE_PAGE_IMAGES_MAX } from "../../../../shared/protocol.js";

export class PdfError extends Error {}

/** 一页少于这么多字，就当这一页没有文字层。 */
const EMPTY_PAGE_CHARS = 16;

/** 画成图的页面长边像素：够看清正文小字，又不让一张图太大。 */
const PAGE_IMAGE_EDGE = 1600;

/** 一页上的文字按 pdf.js 给出的顺序拼起来：换行看 hasEOL，同一行两段之间隔得开才补空格（中文不补）。 */
function pageText(items: ReadonlyArray<{ str?: string; hasEOL?: boolean; transform?: number[]; width?: number }>): string {
  let out = "";
  let lastEnd: number | null = null;
  let lastY: number | null = null;

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const [scaleX = 1, , , scaleY = 1, x = 0, y = 0] = item.transform ?? [];
    const size = Math.max(Math.abs(scaleX), Math.abs(scaleY), 1);

    if (lastY !== null && Math.abs(y - lastY) > size * 0.8 && !out.endsWith("\n")) out += "\n";
    else if (lastEnd !== null && x - lastEnd > size * 0.25 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
      const cjk = /[　-鿿＀-￯]$/.test(out) || /^[　-鿿＀-￯]/.test(item.str);

      if (!cjk) out += " ";
    }

    out += item.str;
    lastEnd = x + (item.width ?? 0);
    lastY = y;

    if (item.hasEOL) { out += "\n"; lastEnd = null; }
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 画出来几乎全白：空白页（扫描时夹进去的、排版留的），不当成扫描件发给模型。 */
function looksBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement("canvas");
  probe.width = 64;
  probe.height = Math.max(1, Math.round(64 * canvas.height / canvas.width));
  const context = probe.getContext("2d", { willReadFrequently: true });

  if (!context) return false;
  context.drawImage(canvas, 0, 0, probe.width, probe.height);
  const { data } = context.getImageData(0, 0, probe.width, probe.height);
  let ink = 0;

  for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! < 720) ink++;

  return ink / (data.length / 4) < 0.002;
}

/** 画一页；空白页返回 null。 */
async function renderPage(doc: PDFDocumentProxy, pageNumber: number): Promise<string | null> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: PAGE_IMAGE_EDGE / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext("2d");

  if (!context) throw new PdfError("画不出这一页");
  // 扫描件常是透明底：先铺白，免得 JPEG 把透明处压成黑色。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  page.cleanup();

  if (looksBlank(canvas)) return null;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export interface PdfRead {
  text: string;
  pages: number;
  pageImages: Array<{ page: number; mimeType: "image/jpeg"; dataBase64: string }>;
  note?: string;
}

export async function readPdf(bytes: Uint8Array, onProgress: (fraction: number) => void): Promise<PdfRead> {
  GlobalWorkerOptions.workerSrc ||= chrome.runtime.getURL("pdf.worker.mjs");
  const task = getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"), cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("pdfjs/standard_fonts/"),
  });
  // 加了密码的 PDF：pdf.js 会等着要密码。侧栏没有地方输入，就停下读取，说明原因。
  let password: number | null = null;
  task.onPassword = (_update: unknown, reason: number) => {
    password = reason;
    void task.destroy();
  };

  let doc: PDFDocumentProxy;

  try {
    doc = await task.promise;
  } catch (error) {
    if (password !== null) throw new PdfError(password === PasswordResponses.INCORRECT_PASSWORD ? "PDF 的密码不对" : "PDF 加了密码，先在电脑上去掉密码再附上");
    const name = (error as { name?: string } | null)?.name;

    if (name === "PasswordException") throw new PdfError("PDF 加了密码，先在电脑上去掉密码再附上");

    throw new PdfError(name === "InvalidPDFException" ? "这不是有效的 PDF 文件，或者文件已损坏" : `读不了这份 PDF：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const blocks: string[] = [];
    const empty: number[] = [];

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items as Parameters<typeof pageText>[0]);
      page.cleanup();

      if (text.replace(/\s/g, "").length < EMPTY_PAGE_CHARS) empty.push(n);
      blocks.push(`[Page ${n}]\n${text}`);
      onProgress(n / doc.numPages * 0.85);
    }

    const pageImages: PdfRead["pageImages"] = [];
    const blank: number[] = [];
    let unrendered = 0;

    for (const n of empty) {
      if (pageImages.length >= FILE_PAGE_IMAGES_MAX) { unrendered++; continue; }
      const image = await renderPage(doc, n);

      if (image) pageImages.push({ page: n, mimeType: "image/jpeg", dataBase64: image });
      else blank.push(n);
      onProgress(0.85 + (pageImages.length + blank.length) / Math.min(empty.length, FILE_PAGE_IMAGES_MAX + blank.length) * 0.15);
    }

    for (const n of blank) blocks[n - 1] = `[Page ${n}]\n(blank page)`;
    const scanned = empty.filter(n => !blank.includes(n));
    const note = !scanned.length ? undefined
      : `${scanned.length === doc.numPages ? "整份 PDF" : `第 ${compactRanges(scanned)} 页`}没有文字层（像是扫描件或图片）。${pageImages.length ? `其中 ${pageImages.length} 页画成了图附上。` : ""}${unrendered > 0 ? `另有 ${unrendered} 页没画，读不到内容。` : ""}`;

    return { text: blocks.join("\n\n"), pages: doc.numPages, pageImages, ...(note ? { note } : {}) };
  } finally {
    void task.destroy();
  }
}

/** [1,2,3,7,9,10] → "1–3、7、9–10" */
function compactRanges(pages: number[]): string {
  const out: string[] = [];

  for (let i = 0; i < pages.length;) {
    let j = i;

    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(i === j ? String(pages[i]) : `${pages[i]}–${pages[j]}`);
    i = j + 1;
  }

  return out.join("、");
}
