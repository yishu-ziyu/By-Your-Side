/**
 * 会话里的文件（产物）：模型写出 CSV、Markdown、HTML 等文本文件，侧栏显示成卡片，用户点一下下载。
 * 命令沿用 Pi web-ui 的 artifacts 工具约定（create / update / rewrite / get / delete），模型对它已熟悉；
 * 扩展可注入持久存储，事务完成后每次改动发 `artifact` 事件，侧栏据此画卡片。见 docs/evals/20260925-artifacts-files.md。
 * `browser_run` 的 `browser.saveFile` 写进同一文件区，工具拿到的大段数据不经模型重打（docs/evals/20261001-data-to-file.md）。
 * 只有交给用户的文件才有卡片：模型存文件时标 deliver，没标的是助手自己用的中间文件（如要上传的文件），
 * 照样存、能读能改，但侧栏不显示（docs/evals/20261010-panel-tidy.md）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { defineTool } from "./define-tool.js";

/** 单个文本文件上限；图片另有独立上限。 */
export const ARTIFACT_MAX_CHARS = 256_000;

/** 交给用户的截图（PNG 的 base64）上限：约 6 MB 图片；更大的整页长图请用户缩小范围。 */
export const IMAGE_ARTIFACT_MAX_CHARS = 8_000_000;

/** 只接受一层文件名：不许带目录、不许以点开头，扩展名决定侧栏怎么显示与下载。 */
const FILENAME = /^[^/\\:*?"<>|.][^/\\:*?"<>|]{0,99}\.[A-Za-z0-9]{1,8}$/;

/**
 * 本会话的文件区：`artifacts` 工具与 `browser_run` 里的 `browser.saveFile` 共用同一份，
 * 规则（文件名、大小）与侧栏卡片事件只在这里一处。
 */
export interface ArtifactStore {
  /** 文件内容；截图文件是 base64，用 isImage 区分。 */
  get(filename: string): string | undefined;
  /** 这个文件是交给用户的图片（内容是 base64，不能当文字读或改）。 */
  isImage(filename: string): boolean;
  names(): string[];
  /**
   * 校验文件名与大小后保存；返回是否覆盖了同名文件、侧栏是否显示卡片。
   * deliver 为真或这个文件已经交给过用户时才发 `artifact` 事件（卡片），否则只存不显示。
   */
  save(filename: string, content: string, deliver?: boolean): { overwritten: boolean; shown: boolean };
  /** 把一张 PNG 图（base64）存成交给用户的图片文件：文件名自动取 截图-<本地时间>.png，同秒重名加序号。 */
  saveImage(base64: string, at?: Date): { filename: string };
  delete(filename: string): boolean;
  flush?(): Promise<void>;
}

export function assertArtifactFilename(filename: string): void {
  if (!FILENAME.test(filename)) throw new Error(`文件名无效：${JSON.stringify(filename)}。只用一层文件名并带扩展名，例如 products.csv。`);
}

export type ArtifactData = {filename: string; content: string; encoding?: "base64"};

export interface ArtifactPersistence {
  load(): Promise<ArtifactData[]>;
  save(item: ArtifactData): Promise<void>;
  delete(filename: string): Promise<void>;
}

export function createArtifactStore(emit: (event: AgentUiEvent) => void, persistence?: ArtifactPersistence, initial: ArtifactData[] = []): ArtifactStore {
  const files = new Map<string, string>();
  const images = new Set<string>();
  /** 已经有卡片的文件：之后再改不必重标 deliver。恢复出来的文件不知道当初标没标，按有卡片算（与升级前一致）。 */
  const shown = new Set<string>();

  for (const item of initial) {
    files.set(item.filename, item.content);
    shown.add(item.filename);

    if (item.encoding === "base64") images.add(item.filename);
  }

  let tail: Promise<void> = Promise.resolve();
  let failure: unknown;

  /** 先落盘再发事件；visible 为假（中间文件）时只落盘，不发侧栏事件。 */
  const publish = (event: Extract<AgentUiEvent,{kind:"artifact"}>, visible = true) => {
    if (!persistence) {
      if (visible) emit(event);

      return;
    }

    tail = tail.then(async () => {
      if(failure)throw failure;

      if(event.action === "deleted") await persistence.delete(event.filename);
      else {
        const item: ArtifactData = {filename:event.filename,content:event.content!};

        if(event.encoding)item.encoding=event.encoding;
        await persistence.save(item);
      }

      if (visible) emit(event);
    }).catch(error => { failure=error; });
  };

  const pad = (n: number) => String(n).padStart(2, "0");

  return {
    flush: async () => {
      await tail;

      if (failure) throw failure;
    },
    get: filename => files.get(filename),
    isImage: filename => images.has(filename),
    names: () => [...files.keys()],
    save(filename, content, deliver) {
      assertArtifactFilename(filename);

      if (content.length > ARTIFACT_MAX_CHARS) throw new Error(`文件过大（${content.length} 字符，上限 ${ARTIFACT_MAX_CHARS}），未保存。请拆成多个文件或精简内容。`);
      const overwritten = files.has(filename);
      files.set(filename, content);
      images.delete(filename);

      if (deliver) shown.add(filename);

      publish({ kind: "artifact", action: "saved", filename, content }, shown.has(filename));

      return { overwritten, shown: shown.has(filename) };
    },
    saveImage(base64, at = new Date()) {
      if (!base64) throw new Error("截图是空的，没有交给用户。");

      if (base64.length > IMAGE_ARTIFACT_MAX_CHARS) throw new Error(`截图过大（${base64.length} 字符，上限 ${IMAGE_ARTIFACT_MAX_CHARS}），没有交给用户。请改截可见区域或一块区域。`);
      const stem = `截图-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
      let filename = `${stem}.png`;

      for (let n = 2; files.has(filename); n += 1) filename = `${stem}-${n}.png`;
      files.set(filename, base64);
      images.add(filename);
      shown.add(filename);
      publish({ kind: "artifact", action: "saved", filename, content: base64, encoding: "base64" });

      return { filename };
    },
    delete(filename) {
      if (!files.delete(filename)) return false;
      images.delete(filename);
      publish({ kind: "artifact", action: "deleted", filename }, shown.delete(filename));

      return true;
    },
  };
}

/** 程序里存文件的回执：只有文件名与长度，内容不回到模型上下文；shown 说侧栏有没有这张卡片。 */
export type SavedFileReceipt = { filename: string; chars: number; lines: number; overwritten: boolean; shown: boolean };

const SAVE_FILE_PARAMS = Type.Object({ filename: Type.String(), content: Type.String({ minLength: 1 }), deliver: Type.Optional(Type.Boolean()) });

export type SaveFileParams = Static<typeof SAVE_FILE_PARAMS>;

/** 程序传来的是 JSON；按 schema 认，不把数组、对象或空内容悄悄转成文本。 */
export function isSaveFileParams(value: unknown): value is SaveFileParams {
  return Check(SAVE_FILE_PARAMS, value);
}

export function rejectSaveFileParams(): never {
  throw new Error("INVALID_ARGUMENT: saveFile 需要 {filename: 字符串, content: 非空字符串, deliver?: 布尔}；表格或对象先在程序里拼成 CSV/JSON 文本，空内容不保存。");
}

/** `browser.saveFile({filename, content, deliver})` 的宿主实现：与 `artifacts` 同一文件区、同一规则；deliver 为真才有卡片。 */
export function saveFileFromProgram(store: ArtifactStore, params: SaveFileParams): SavedFileReceipt {
  const filename = params.filename.trim();
  const { content } = params;
  const { overwritten, shown } = store.save(filename, content, params.deliver === true);
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  return { filename, chars: content.length, lines, overwritten, shown };
}

export type ArtifactsToolOptions = { emit: (event: AgentUiEvent) => void; /** 与 browser_run 共用时传入；不传则自建。 */ store?: ArtifactStore };

type Command = "create" | "update" | "rewrite" | "get" | "delete";

export function createArtifactsTool(opts: ArtifactsToolOptions): ToolDefinition {
  const store = opts.store ?? createArtifactStore(opts.emit);
  const names = store.names;

  const listed = () => (names().length ? `现有文件：${names().join("、")}` : "本会话还没有文件。");

  const save = (filename: string, content: string, verb: string, deliver: boolean) => {
    const { shown } = store.save(filename, content, deliver);

    return shown ? `${verb} ${filename}（${content.length} 字符），侧栏已显示文件卡片，用户可点击${/\.(html|htm)$/i.test(filename) ? "交互预览、打开或下载" : "下载"}。`
      : `${verb} ${filename}（${content.length} 字符）。这是工作文件：用户看不到，侧栏没有卡片。要交给用户时用 rewrite 再存一次并带 deliver: true。`;
  };

  return defineTool({
    name: "artifacts",
    label: "Files for the user",
    description:
      "Create text files the user can download from the side panel: .csv, .md, .txt, .json, .html, .svg, .js, .css. Use it when the user asks for a file, an export, a document, a table to download, or a small standalone tool, and set deliver: true on that save: only then the file appears as a card with download/open buttons. Without deliver the file is a working file (for example one you will upload with upload_file): saved and readable here, but the user does not see it. An HTML card also has an opt-in in-conversation interactive preview in an isolated sandbox. A clickable choice inside HTML may call window.parent.postMessage({sideagentResultChoice:1,label:'Route B'}, '*'); this only offers the user a button to put that text in their unsent input draft and never executes a browser action. Never claim a choice has been submitted until the user actually sends it. Commands: create (filename + content; fails if it exists), update (replace old_str with new_str; preferred for small edits), rewrite (replace the whole content), get (read it back), delete. Files live only in this conversation. For CSV include a header row. Do not retype large data you already obtained with tools (page or API extraction longer than a few thousand characters): build the file inside browser_run with browser.saveFile({filename, content}) instead; pass deliver: true there too when the user asked for the file; it lands in this same file list, and you can get or update it here afterwards. Binary formats (pdf, docx, xlsx) are not supported.",
    parameters: Type.Object({
      command: Type.Unsafe<Command>(Type.String({ description: "create, update, rewrite, get or delete" })),
      filename: Type.String({ description: "File name with extension, no folders, e.g. products.csv" }),
      content: Type.Optional(Type.String({ description: "Full file content, for create and rewrite" })),
      old_str: Type.Optional(Type.String({ description: "Exact text to replace, for update" })),
      new_str: Type.Optional(Type.String({ description: "Replacement text, for update" })),
      deliver: Type.Optional(Type.Boolean({ description: "true only when this file is what the user asked for (a file, export, download, table or tool to keep); it then shows as a card. Omit it for working files (e.g. a file you will upload with upload_file)." })),
    }),
    execute: async (_id, params) => {
      const filename = String(params.filename ?? "").trim();

      assertArtifactFilename(filename);

      // 截图是给用户看的图片，内容是 base64：不当文字读回、也不能改，只能删。
      if (store.isImage(filename) && params.command !== "delete" && params.command !== "create") {
        if (params.command === "get") return { content: [{ type: "text" as const, text: `${filename} 是交给用户的截图，已在侧栏显示成图片；图片内容不能当文字读取。` }], details: undefined };
        throw new Error(`${filename} 是截图图片，不能用 ${String(params.command)} 修改；需要新图请重新截图。`);
      }

      const existing = store.get(filename);
      let text: string;

      switch (params.command) {
        case "create":
          if (existing !== undefined) throw new Error(`${filename} 已存在；改动用 update 或 rewrite。`);

          if (!params.content) throw new Error("create 需要 content。");
          text = save(filename, params.content, "已创建", params.deliver === true);
          break;
        case "update":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);

          if (!params.old_str || params.new_str === undefined) throw new Error("update 需要 old_str 和 new_str。");

          if (!existing.includes(params.old_str)) throw new Error(`${filename} 里找不到要替换的文字。当前全文：\n\n${existing}`);
          text = save(filename, existing.replace(params.old_str, params.new_str), "已修改", params.deliver === true);
          break;
        case "rewrite":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);

          if (!params.content) throw new Error("rewrite 需要 content。");
          text = save(filename, params.content, "已重写", params.deliver === true);
          break;
        case "get":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);
          text = existing;
          break;
        case "delete":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);
          store.delete(filename);
          text = `已删除 ${filename}。`;
          break;
        default:
          throw new Error(`未知命令 ${String(params.command)}；可用 create、update、rewrite、get、delete。`);
      }

      await store.flush?.();

      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
