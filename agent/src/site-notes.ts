import type { DocumentPersistence } from "./document-persistence.js";

export function siteKey(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");

  if (/^[\d.]+$/.test(name) || name.includes(":") || !name.includes(".")) return name;
  const labels = name.split(".");
  const keep = labels.length >= 3 && /^[a-z]{2}$/.test(labels.at(-1)!) && /^(com|net|org|gov|edu|ac|co)$/.test(labels.at(-2)!) ? 3 : 2;

  return labels.slice(-keep).join(".");
}

type SiteNote = { text: string; runId: string; at: number };
type SiteNotesFile = { format: 1; sites: Record<string, SiteNote[]> };

function isSiteNote(value: unknown): value is SiteNote {
  return !!value && typeof value === "object" && "text" in value && typeof value.text === "string" && value.text.length > 0 && value.text.length <= 200
    && "runId" in value && typeof value.runId === "string" && "at" in value && typeof value.at === "number" && Number.isFinite(value.at);
}

/** Existing notes remain available for local management, without a learning or model-read API. */
export class SiteNotesStore {
  constructor(private readonly doc: DocumentPersistence) {}

  private async load(): Promise<SiteNotesFile> {
    const raw = await this.doc.read();
    if (raw === null) return { format: 1, sites: {} };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("format" in value) || value.format !== 1 || !("sites" in value)
      || !value.sites || typeof value.sites !== "object" || Array.isArray(value.sites)) throw new Error("站点笔记格式无法读取，原数据已保留。");
    const sites: Record<string, SiteNote[]> = Object.create(null);
    for (const [host, notes] of Object.entries(value.sites)) {
      if (!Array.isArray(notes) || !notes.every(isSiteNote)) throw new Error("站点笔记格式无法读取，原数据已保留。");
      sites[host] = notes;
    }
    return { format: 1, sites };
  }

  async list(): Promise<{ notes: Array<{ host: string; text: string; runId: string }> }> {
    const { sites } = await this.load();
    return { notes: Object.entries(sites).flatMap(([host, notes]) => notes.map(({ text, runId }) => ({ host, text, runId }))) };
  }

  async remove(host: string, text: string, runId: string): Promise<void> {
    await this.doc.exclusive(async () => {
      const file = await this.load();
      const notes = file.sites[host];
      if (!notes) return;
      const remaining = notes.filter(note => note.text !== text || note.runId !== runId);
      if (remaining.length === notes.length) return;
      if (remaining.length) file.sites[host] = remaining; else delete file.sites[host];
      await this.doc.write(JSON.stringify(file) + "\n");
    });
  }
}

const TYPED_ARGS: Record<string, readonly string[]> = { fill: ["value"], type_text: ["text"], select_option: ["value", "values"], accept_dialog: ["promptText"] };

/** 代码里写进页面的值：`.value = '…'` 和 `value: '…'`。 */
const CODE_VALUES = [/\.value\s*=\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, /\bvalue\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g];

/** 一个参数值里所有的字符串（嵌套的对象、数组也算）。 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];

  if (Array.isArray(value)) return value.flatMap(stringsIn);

  return value && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : [];
}

/** 一次填写或输入的值（含 browser_run 子步骤、页面 JS 里的赋值）；网页上被填进去的具体内容。 */
export function typedValuesOf(name: string, params: Record<string, unknown>): string[] {
  const direct = (TYPED_ARGS[name] ?? []).flatMap(key => stringsIn(params[key]));
  const code = (name === "js" || name === "browser_run") && typeof params.code === "string" ? CODE_VALUES.flatMap(re => [...(params.code as string).matchAll(re)].map(match => match[2]!)) : [];

  return [...direct, ...code].map(value => value.trim()).filter(value => value !== "");
}
