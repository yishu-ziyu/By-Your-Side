/**
 * 哪些文件能读、读不了时怎么说。侧栏一开就要用，所以和解析代码（file-read.js）分开，不随侧栏加载 pdf.js。
 */
import { FILE_READ_MAX_BYTES, type FileFormat } from "../../../../shared/protocol.js";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log", "json", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "sql", "css", "scss", "less", "vue", "svelte", "lua", "r", "m", "dart", "scala", "tex", "bib", "srt", "vtt", "ipynb",
]);

const LEGACY_OFFICE: Record<string, string> = { doc: "Word 97-2003（.doc）", xls: "Excel 97-2003（.xls）", ppt: "PowerPoint 97-2003（.ppt）" };

const OTHER_HINTS: Record<string, string> = {
  pages: "Pages 文件请先导出成 Word 或 PDF", numbers: "Numbers 文件请先导出成 Excel 或 CSV", key: "Keynote 文件请先导出成 PowerPoint 或 PDF",
  zip: "压缩包请先解压，再附上里面的文件", rar: "压缩包请先解压，再附上里面的文件", "7z": "压缩包请先解压，再附上里面的文件",
};

const extensionOf = (name: string): string => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** 侧栏要不要把这个文件当文件读（图片走原来的图片附件）。 */
export function readableFormat(file: File): FileFormat | null {
  const ext = extensionOf(file.name);

  if (ext === "pdf" || file.type === "application/pdf") return "pdf";

  if (ext === "docx") return "docx";

  if (ext === "xlsx" || ext === "xlsm") return "xlsx";

  if (ext === "pptx") return "pptx";

  if (ext === "csv" || ext === "tsv" || file.type === "text/csv") return "csv";

  if (ext === "html" || ext === "htm" || file.type === "text/html") return "html";

  if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith("text/") || file.type === "application/json") return "text";

  return null;
}

/** 读不了时给用户的一句话：说清是什么格式、可以怎么办。 */
export function unsupportedReason(file: File): string {
  const ext = extensionOf(file.name);

  if (LEGACY_OFFICE[ext]) return `${file.name} 是旧版 ${LEGACY_OFFICE[ext]} 格式，读不了。请在 Office 或 WPS 里另存为新格式（.${ext}x）再附上。`;

  if (OTHER_HINTS[ext]) return `${file.name}：${OTHER_HINTS[ext]}。`;

  return `${file.name} 的格式读不了。能读的有 PDF、Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）、CSV、文本和代码文件，以及图片。`;
}
