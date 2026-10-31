/**
 * 侧栏附上的文件在本机读成文字（file-read.js，用到时才加载，不拖慢侧栏打开）。
 * 返回的附件只带文字和必要的图，原文件只在不大时随附件留着，供 upload_file 原样上传。
 */
import { FILE_BYTES_KEEP_MAX, FILE_READ_MAX_BYTES, FILE_TEXT_MAX, type FileAttachment, type FileFormat } from "../../../../shared/protocol.js";
import { OfficeError, readDocx, readPptx, readXlsx } from "./ooxml.js";
import { PdfError, readPdf } from "./pdf.js";
import { cleanText, decodeText, htmlText } from "./text.js";
import { ZipError, ZipReader } from "./zip.js";
import { readableFormat, unsupportedReason } from "./formats.js";

export class FileReadError extends Error {}

function base64(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);

  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 有些文件扩展名对不上内容（例如 .xlsx 实为 CSV）：用文件头认一次，免得报「已损坏」。 */
function sniff(bytes: Uint8Array, format: FileFormat): FileFormat {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

  if (pdf) return "pdf";

  if ((format === "docx" || format === "xlsx" || format === "pptx") && !zip) return "text";

  return format;
}

export async function readAttachmentFile(file: File, id: string, onProgress: (fraction: number) => void = () => {}): Promise<FileAttachment> {
  const declared = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(file.type) ? "image" : readableFormat(file);

  if (!declared) throw new FileReadError(unsupportedReason(file));

  if (file.size > FILE_READ_MAX_BYTES) throw new FileReadError(`${file.name} 有 ${(file.size / 1024 / 1024).toFixed(0)} MB，超过 ${FILE_READ_MAX_BYTES / 1024 / 1024} MB，读不了。可以只附上需要的那几页或那一部分。`);

  if (file.size === 0) throw new FileReadError(`${file.name} 是空文件。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // PDF 解析可能把字节所有权转给 worker；先留下原件身份和可上传副本，再交给解析器。
  const originalSha256 = await sha256(bytes);
  const originalBase64 = file.size <= FILE_BYTES_KEEP_MAX ? base64(bytes) : undefined;
  const format = sniff(bytes, declared);
  let text: string;
  let parts: FileAttachment["parts"];
  let pageImages: FileAttachment["pageImages"];
  let note: string | undefined;

  try {
    if (format === "image") {
      text = "图片原件可用于上传；尚未提取图片中的文字。";
    } else if (format === "pdf") {
      const pdf = await readPdf(bytes, onProgress);
      ({ text, note } = pdf);
      parts = { kind: "page", count: pdf.pages };

      if (pdf.pageImages.length) pageImages = pdf.pageImages;
    } else if (format === "docx" || format === "xlsx" || format === "pptx") {
      const zip = ZipReader.open(bytes);

      if (format === "docx") text = await readDocx(zip);
      else if (format === "xlsx") {
        const sheet = await readXlsx(zip);
        ({ text, note } = sheet);
        parts = { kind: "sheet", count: sheet.sheets };
      } else {
        const deck = await readPptx(zip);
        text = deck.text;
        parts = { kind: "slide", count: deck.slides };
      }
    } else {
      const raw = cleanText(decodeText(bytes));
      text = format === "html" ? htmlText(raw) : raw;
    }
  } catch (error) {
    if (error instanceof PdfError || error instanceof OfficeError || error instanceof ZipError) throw new FileReadError(`${file.name}：${error.message}。`);

    throw new FileReadError(`${file.name} 没读出来：${error instanceof Error ? error.message : String(error)}`);
  }

  onProgress(1);
  text = cleanText(text);
  const truncated = text.length > FILE_TEXT_MAX;

  if (truncated) {
    text = text.slice(0, FILE_TEXT_MAX);
    note = [note, `文字太多，只留了前 ${FILE_TEXT_MAX.toLocaleString("en-US")} 个字符。`].filter(Boolean).join(" ");
  }

  if (!text.replace(/\[(Page \d+|Sheet: [^\]]+|Slide \d+)\][^\n]*/g, "").trim() && !pageImages?.length) {
    throw new FileReadError(`${file.name} 里没有读得出的文字。`);
  }

  const mimeType = file.type || (format === "pdf" ? "application/pdf" : format === "csv" ? "text/csv" : "application/octet-stream");

  return {
    id, type: "file", name: file.name, mimeType, size: file.size, sha256: originalSha256, format, text,
    ...(parts ? { parts } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    ...(pageImages ? { pageImages } : {}),
    ...(originalBase64 ? { dataBase64: originalBase64 } : {}),
    ...(note ? { note: note.slice(0, 600) } : {}),
  };
}
