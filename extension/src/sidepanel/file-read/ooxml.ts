/**
 * Word（docx）、Excel（xlsx）、PowerPoint（pptx）读成文字。三者都是 zip 里的 XML（Office Open XML）。
 * 按元素的 localName 认结构，不认前缀：Word、WPS、LibreOffice、Google 导出的文件前缀写法不同，含义相同。
 */
import { ZipReader } from "./zip.js";

export class OfficeError extends Error {}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");

  if (doc.getElementsByTagName("parsererror").length) throw new OfficeError("文件里的内容已损坏");

  return doc;
}

async function xmlOf(zip: ZipReader, name: string): Promise<Document | null> {
  const text = await zip.textOf(name);

  return text === null ? null : parseXml(text);
}

function children(node: Element, name?: string): Element[] {
  return [...node.children].filter(child => !name || child.localName === name);
}

function child(node: Element | null | undefined, name: string): Element | null {
  return node ? children(node, name)[0] ?? null : null;
}

function descendants(node: Element | Document, name: string): Element[] {
  return [...node.getElementsByTagNameNS("*", name)];
}

/** 属性按 localName 取（w:val、r:id 这类带前缀的属性）。 */
function attr(node: Element | null | undefined, name: string): string | null {
  if (!node) return null;

  for (const a of node.attributes) if (a.localName === name) return a.value;

  return null;
}

/**
 * 关系编号 r:id。不能按 localName 取：幻灯片列表的 <p:sldId id="256" r:id="rId2"> 里两个属性的 localName 都是 id。
 */
function relId(node: Element | null | undefined): string | null {
  if (!node) return null;

  for (const a of node.attributes) if (a.localName === "id" && a.namespaceURI?.endsWith("/relationships")) return a.value;

  return null;
}

/** 关系文件：r:id → 目标路径（相对 base 所在目录解析成 zip 里的完整路径）。 */
async function relations(zip: ZipReader, part: string): Promise<Map<string, string>> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const rels = await xmlOf(zip, `${dir}_rels/${part.slice(dir.length)}.rels`);
  const map = new Map<string, string>();

  if (!rels) return map;

  for (const rel of descendants(rels, "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");

    if (!id || !target || attr(rel, "TargetMode") === "External") continue;
    map.set(id, resolvePath(dir, target));
  }

  return map;
}

function resolvePath(dir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : dir + target).split("/");
  const out: string[] = [];

  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }

  return out.join("/");
}

const tidy = (text: string): string => text.replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** 表格行：单元格里的换行压成空格、竖线转义，免得把一行拆散。 */
const tableRow = (cells: string[]): string => `| ${cells.map(cell => cell.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()).join(" | ")} |`;

// ── Word ───────────────────────────────────────────────────────────

interface WordStyles { headings: Map<string, number>; lists: Set<string> }

/** 标题级别看样式名而不看样式 id：中文版 Word 的「标题 1」id 是 "1"，名字仍是 "heading 1"。 */
async function wordStyles(zip: ZipReader): Promise<WordStyles> {
  const doc = await xmlOf(zip, "word/styles.xml");
  const headings = new Map<string, number>();
  const lists = new Set<string>();

  for (const style of doc ? descendants(doc, "style") : []) {
    const id = attr(style, "styleId");
    const name = (attr(child(style, "name"), "val") ?? "").toLowerCase();
    const outline = attr(child(child(style, "pPr"), "outlineLvl"), "val");
    const level = name === "title" ? 1 : /^heading\s*(\d)$/.exec(name)?.[1] ?? (outline !== null ? String(Number(outline) + 1) : null);

    if (id && level) headings.set(id, Math.min(6, Number(level)));

    // 「列表项目符号」这类样式自带编号：段落本身没有 numPr，也是列表项。
    if (id && (child(child(style, "pPr"), "numPr") || /^list (bullet|number)/.test(name))) lists.add(id);
  }

  return { headings, lists };
}

/** 一个段落里的文字：跳过已删除的修订（w:del）和域代码，保留插入的修订、超链接、内容控件里的字。 */
function runText(node: Element): string {
  let out = "";

  for (const el of children(node)) {
    switch (el.localName) {
      case "t": out += el.textContent ?? ""; break;
      case "tab": out += "\t"; break;
      case "br": case "cr": out += "\n"; break;
      case "noBreakHyphen": out += "-"; break;
      case "del": case "instrText": case "delText": case "pPr": case "rPr": break;
      default: out += runText(el);
    }
  }

  return out;
}

function wordParagraph(p: Element, styles: WordStyles): string {
  const pPr = child(p, "pPr");
  const text = runText(p).trim();

  if (!text) return "";
  const styleId = attr(child(pPr, "pStyle"), "val");
  const outline = attr(child(pPr, "outlineLvl"), "val");
  const level = (styleId && styles.headings.get(styleId)) || (outline !== null ? Math.min(6, Number(outline) + 1) : 0);

  if (level) return `${"#".repeat(level)} ${text}`;

  if (child(pPr, "numPr") || (styleId && styles.lists.has(styleId))) return `${"  ".repeat(Number(attr(child(child(pPr, "numPr"), "ilvl"), "val") ?? 0))}- ${text}`;

  return text;
}

function wordTable(tbl: Element, styles: WordStyles): string {
  const rows = children(tbl, "tr").map(tr => children(tr, "tc").map(tc => wordBlocks(tc, styles).join(" ")));

  if (!rows.length) return "";
  const width = Math.max(...rows.map(row => row.length));
  const lines = rows.map(row => tableRow([...row, ...Array(width - row.length).fill("")]));

  return [lines[0], tableRow(Array(width).fill("---")), ...lines.slice(1)].join("\n");
}

function wordBlocks(container: Element, styles: WordStyles): string[] {
  const out: string[] = [];

  for (const el of children(container)) {
    if (el.localName === "p") out.push(wordParagraph(el, styles));
    else if (el.localName === "tbl") out.push(wordTable(el, styles));
    // 内容控件、修订插入、自定义 XML 里还套着段落。
    else if (["sdt", "sdtContent", "customXml", "ins", "smartTag"].includes(el.localName)) out.push(...wordBlocks(el, styles));
  }

  return out.filter(Boolean);
}

export async function readDocx(zip: ZipReader): Promise<string> {
  const doc = await xmlOf(zip, "word/document.xml");
  const body = doc && descendants(doc, "body")[0];

  if (!body) throw new OfficeError("这不是有效的 Word 文件");
  const styles = await wordStyles(zip);
  const sections = [wordBlocks(body, styles).join("\n\n")];

  for (const [part, title] of [["word/footnotes.xml", "Footnotes"], ["word/endnotes.xml", "Endnotes"]] as const) {
    const notes = await xmlOf(zip, part);
    // 编号 -1、0 是 Word 自带的分隔符脚注，没有正文。
    const texts = notes ? descendants(notes, part.includes("foot") ? "footnote" : "endnote").filter(note => Number(attr(note, "id")) > 0).map(note => wordBlocks(note, styles).join(" ")).filter(Boolean) : [];

    if (texts.length) sections.push(`## ${title}\n${texts.map((text, i) => `${i + 1}. ${text}`).join("\n")}`);
  }

  const comments = await xmlOf(zip, "word/comments.xml");
  const notes = comments ? descendants(comments, "comment").map(comment => `- ${attr(comment, "author") ?? ""}: ${wordBlocks(comment, styles).join(" ")}`).filter(line => line.length > 4) : [];

  if (notes.length) sections.push(`## Comments\n${notes.join("\n")}`);

  return tidy(sections.join("\n\n"));
}

// ── Excel ──────────────────────────────────────────────────────────

/** 每张表最多读这么多行、这么多列；更大的表只取前面，并在文字里写明。 */
const SHEET_ROWS_MAX = 5_000;
const SHEET_COLS_MAX = 60;

/** Excel 内置的日期时间格式编号。 */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  // 去掉引号里的字面量、方括号里的颜色和区域设置、转义字符，再看有没有日期时间占位符。
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");

  return /[ymdhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** 序列号 → 日期：1900 日期系统把 1900-02-29 也算了一天（Lotus 的历史错误），60 以后要减一天。 */
function excelDate(serial: number, date1904: boolean): string {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 19);

  if (serial < 1) return time;

  return time === "00:00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

/** 浮点误差（0.1+0.2 存成 0.30000000000000004）按 15 位有效数字收回。 */
function excelNumber(raw: string): string {
  const n = Number(raw);

  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
}

function columnIndex(ref: string): number {
  let n = 0;

  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;

  return n - 1;
}

function columnName(index: number): string {
  let name = "";

  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;

  return name;
}

/** 共享字符串里的富文本：每段 r 的 t 连起来；拼音注音（rPh）不算正文。 */
function stringItem(si: Element): string {
  const direct = child(si, "t");

  if (direct) return direct.textContent ?? "";

  return children(si, "r").map(r => child(r, "t")?.textContent ?? "").join("");
}

export async function readXlsx(zip: ZipReader): Promise<{ text: string; sheets: number; note?: string }> {
  const workbook = await xmlOf(zip, "xl/workbook.xml");

  if (!workbook) throw new OfficeError("这不是有效的 Excel 文件");
  const rels = await relations(zip, "xl/workbook.xml");
  const date1904 = ["1", "true"].includes(attr(descendants(workbook, "workbookPr")[0], "date1904") ?? "");
  const shared = await xmlOf(zip, "xl/sharedStrings.xml");
  const strings = shared ? children(shared.documentElement, "si").map(stringItem) : [];
  const stylesDoc = await xmlOf(zip, "xl/styles.xml");
  const customFormats = new Map<number, string>();

  for (const fmt of stylesDoc ? descendants(stylesDoc, "numFmt") : []) customFormats.set(Number(attr(fmt, "numFmtId")), attr(fmt, "formatCode") ?? "");
  const cellXfs = stylesDoc ? descendants(stylesDoc, "cellXfs")[0] : undefined;
  const dateStyles = (cellXfs ? children(cellXfs, "xf") : []).map(xf => {
    const id = Number(attr(xf, "numFmtId") ?? 0);

    return DATE_FORMAT_IDS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id)!));
  });

  const sections: string[] = [];
  const clipped: string[] = [];
  const sheets = descendants(workbook, "sheet");

  for (const sheet of sheets) {
    const name = attr(sheet, "name") ?? "Sheet";
    const path = rels.get(relId(sheet) ?? "");
    const doc = path ? await xmlOf(zip, path) : null;

    if (!doc) continue;
    const hidden = attr(sheet, "state") && attr(sheet, "state") !== "visible";
    const rows: string[] = [];
    let width = 0;
    let rowCount = 0;

    for (const row of descendants(doc, "row")) {
      const cells: string[] = [];

      for (const c of children(row, "c")) {
        const ref = attr(c, "r");
        const col = ref ? columnIndex(ref) : cells.length;

        if (col >= SHEET_COLS_MAX) continue;
        const type = attr(c, "t");
        const v = child(c, "v")?.textContent ?? "";
        let value: string;

        if (type === "s") value = strings[Number(v)] ?? "";
        else if (type === "inlineStr") value = child(c, "is") ? stringItem(child(c, "is")!) : "";
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (type === "str" || type === "e") value = v;
        else if (v && dateStyles[Number(attr(c, "s") ?? 0)]) value = excelDate(Number(v), date1904);
        else value = v ? excelNumber(v) : "";

        // 程序生成、没被 Excel 打开算过的文件里，公式格没有缓存结果：写出公式本身。
        if (!value && child(c, "f")?.textContent) value = `=${child(c, "f")!.textContent}`;

        while (cells.length < col) cells.push("");
        cells[col] = value.replace(/\s*\n\s*/g, " ").trim();
      }

      while (cells.length && !cells.at(-1)) cells.pop();

      if (!cells.length) continue;
      rowCount++;

      if (rows.length >= SHEET_ROWS_MAX) continue;
      width = Math.max(width, cells.length);
      rows.push(`${attr(row, "r") ?? rowCount} | ${cells.join(" | ")}`);
    }

    if (rowCount > rows.length) clipped.push(`「${name}」只读了前 ${rows.length} 行（共 ${rowCount} 行）`);
    const header = `[Sheet: ${name}]${hidden ? " (hidden)" : ""} ${rowCount} rows × ${width} columns. Each line is: row number | ${Array.from({ length: Math.min(width, 26) }, (_, i) => columnName(i)).join(" | ")}${width > 26 ? " | …" : ""}`;

    sections.push(rows.length ? `${header}\n${rows.join("\n")}` : `${header}\n(empty)`);
  }

  if (!sections.length) throw new OfficeError("这个 Excel 文件里没有工作表");

  return { text: sections.join("\n\n"), sheets: sections.length, ...(clipped.length ? { note: `${clipped.join("；")}。` } : {}) };
}

// ── PowerPoint ─────────────────────────────────────────────────────

function drawingParagraphs(node: Element): string[] {
  return descendants(node, "p").map(p => descendants(p, "t").map(t => t.textContent ?? "").join("").trim()).filter(Boolean);
}

function slideText(doc: Document): string {
  const tree = descendants(doc, "spTree")[0];

  if (!tree) return "";
  const titles: string[] = [];
  const body: string[] = [];

  for (const shape of descendants(tree, "sp")) {
    const type = attr(descendants(shape, "ph")[0], "type");
    const paragraphs = drawingParagraphs(child(shape, "txBody") ?? shape);

    if (!paragraphs.length) continue;

    if (type === "title" || type === "ctrTitle") titles.push(paragraphs.join(" "));
    else body.push(...paragraphs.map(text => `- ${text}`));
  }

  for (const table of descendants(tree, "tbl")) {
    const rows = children(table, "tr").map(tr => children(tr, "tc").map(tc => drawingParagraphs(tc).join(" ")));

    if (rows.length) body.push(rows.map(tableRow).join("\n"));
  }

  return [...titles.map(title => `## ${title}`), ...body].join("\n");
}

export async function readPptx(zip: ZipReader): Promise<{ text: string; slides: number }> {
  const presentation = await xmlOf(zip, "ppt/presentation.xml");

  if (!presentation) throw new OfficeError("这不是有效的 PowerPoint 文件");
  const rels = await relations(zip, "ppt/presentation.xml");
  const sections: string[] = [];
  let index = 0;

  for (const slide of descendants(presentation, "sldId")) {
    const path = rels.get(relId(slide) ?? "");
    const doc = path ? await xmlOf(zip, path) : null;

    if (!doc || !path) continue;
    index++;
    const hidden = attr(doc.documentElement, "show") === "0";
    const lines = [`[Slide ${index}]${hidden ? " (hidden)" : ""}`, slideText(doc)];
    const notesPath = [...(await relations(zip, path)).values()].find(target => /notesSlide\d*\.xml$/.test(target));
    const notes = notesPath ? await xmlOf(zip, notesPath) : null;
    // 备注页里也有幻灯片编号占位符，只取正文占位符里的字。
    const notesText = notes ? descendants(notes, "sp").filter(sp => attr(descendants(sp, "ph")[0], "type") === "body").flatMap(sp => drawingParagraphs(sp)).join("\n") : "";

    if (notesText) lines.push(`Speaker notes: ${notesText}`);
    sections.push(lines.filter(Boolean).join("\n"));
  }

  if (!sections.length) throw new OfficeError("这个 PowerPoint 文件里没有幻灯片");

  return { text: tidy(sections.join("\n\n")), slides: sections.length };
}
