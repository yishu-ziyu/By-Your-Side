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

export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, ch => ch.normalize("NFKC"));
}

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TABLE", "UL", "OL", "BR", "HR"]);

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
