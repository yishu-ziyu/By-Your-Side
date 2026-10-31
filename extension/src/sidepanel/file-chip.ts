/** 文件附件的小卡：类型图标、文件名、「PDF · 12 页」。输入框上方的附件条和已发出的消息里共用。 */
import { createElement as icon, FileCode, FileSpreadsheet, FileText, Globe, Image, Presentation, Sheet } from "lucide";
import type { FileAttachment, FileFormat } from "../../../shared/protocol.js";

const FORMAT_LABEL: Record<FileFormat, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel", pptx: "PPT", csv: "CSV", text: "文本", html: "网页", image: "图片" };

const FORMAT_ICON = { pdf: FileText, docx: FileText, xlsx: Sheet, pptx: Presentation, csv: FileSpreadsheet, text: FileCode, html: Globe, image: Image } as const;

const PART_UNIT = { page: "页", sheet: "张表", slide: "张幻灯片" } as const;

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fileMeta(file: Pick<FileAttachment, "format" | "parts" | "size">): string {
  return [FORMAT_LABEL[file.format], file.parts ? `${file.parts.count} ${PART_UNIT[file.parts.kind]}` : sizeLabel(file.size)].join(" · ");
}

/** 卡片本体；meta 先写「正在读…」，读完再换成真实的页数。 */
export function fileChip(name: string, format: FileFormat, meta: string): { el: HTMLElement; meta: HTMLElement } {
  const el = document.createElement("div");
  el.className = "file-chip";
  el.dataset.format = format;
  const glyph = document.createElement("span");
  glyph.className = "file-chip-icon";
  glyph.append(icon(FORMAT_ICON[format], { width: 18, height: 18, "stroke-width": 1.7, "aria-hidden": "true" }));
  const text = document.createElement("span");
  text.className = "file-chip-text";
  const title = document.createElement("span");
  title.className = "file-chip-name";
  title.textContent = name;
  title.title = name;
  const sub = document.createElement("span");
  sub.className = "file-chip-meta";
  sub.textContent = meta;
  text.append(title, sub);
  el.append(glyph, text);

  return { el, meta: sub };
}
