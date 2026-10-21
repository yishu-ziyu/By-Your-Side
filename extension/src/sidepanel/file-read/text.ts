/** 纯文本类文件（txt、md、csv、json、代码、日志、html）读成文字。 */

/**
 * 字节转文字：有 BOM 按 BOM；否则先严格按 UTF-8，不合法再按 GB18030。
 * 国内 Windows 导出的 csv、txt 常是 GBK，按 UTF-8 硬读会整篇乱码。
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));

  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));

  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

/**
 * 统一换行，去掉 NUL 等控制字符（保留换行和制表）。
 * 康熙部首和兼容汉字换成标准汉字：Chrome、Word 导出的 PDF 常把「方」「日」映射成同形的部首字符，
 * 看着一样，用户拿原文去搜、模型去引用时都对不上。
 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, ch => ch.normalize("NFKC"));
}

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TABLE", "UL", "OL", "BR", "HR"]);

/** HTML 文件只取正文文字：不执行脚本，标题加 #，块级元素之间换行，表格单元格之间用 | 隔开。 */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc.querySelectorAll("script, style, noscript, template, svg").forEach(node => node.remove());
  const out: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.textContent ?? ""); return; }

    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    const heading = /^H([1-6])$/.exec(tag);

    if (BLOCK_TAGS.has(tag)) out.push("\n");

    if (heading) out.push(`${"#".repeat(Number(heading[1]))} `);

    if (tag === "LI") out.push("- ");

    if (tag === "TD" || tag === "TH") out.push(" | ");

    for (const child of node.childNodes) walk(child);

    if (BLOCK_TAGS.has(tag)) out.push("\n");
  };

  walk(doc.body ?? doc.documentElement);
  const title = doc.title.trim();
  const body = out.join("").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return title && !body.startsWith(title) ? `# ${title}\n\n${body}` : body;
}
