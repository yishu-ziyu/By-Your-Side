import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { ANSWER_UI_GUIDE } from "./answer-ui-guide.js";
import { defineTool } from "./define-tool.js";

const ARTIFACT_MAX_CHARS = 256_000;

const IMAGE_ARTIFACT_MAX_CHARS = 8_000_000;

const FILENAME = /^[^/\\:*?"<>|.][^/\\:*?"<>|]{0,99}\.[A-Za-z0-9]{1,8}$/;

export interface ArtifactStore {
  get(filename: string): string | undefined;
  isImage(filename: string): boolean;
  names(): string[];
  save(filename: string, content: string, deliver?: boolean): { overwritten: boolean; shown: boolean };
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
  const shown = new Set<string>();

  for (const item of initial) {
    files.set(item.filename, item.content);
    shown.add(item.filename);

    if (item.encoding === "base64") images.add(item.filename);
  }

  let tail: Promise<void> = Promise.resolve();
  let failure: unknown;

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
      // WHY: 文件在封闭预览里运行，没有 bys.page；存下去用户拿到的是一个打不开页面的工具，而回答还会说它能用。
      if (/\.(html|htm)$/i.test(filename) && /\bbys\.page\b/.test(content)) throw new Error("没有保存：bys.page 只在回答里的 <app> 小程序中可用，文件里用不了。请把这段 HTML 放进 <app title=\"名字\">…</app> 直接写在回答里，不要存成文件。");
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

export type SavedFileReceipt = { filename: string; chars: number; lines: number; overwritten: boolean; shown: boolean };

const SAVE_FILE_PARAMS = Type.Object({ filename: Type.String(), content: Type.String({ minLength: 1 }), deliver: Type.Optional(Type.Boolean()) });

export type SaveFileParams = Static<typeof SAVE_FILE_PARAMS>;

export function isSaveFileParams(value: unknown): value is SaveFileParams {
  return Check(SAVE_FILE_PARAMS, value);
}

export function rejectSaveFileParams(): never {
  throw new Error("INVALID_ARGUMENT: saveFile 需要 {filename: 字符串, content: 非空字符串, deliver?: 布尔}；表格或对象先在程序里拼成 CSV/JSON 文本，空内容不保存。");
}

export function saveFileFromProgram(store: ArtifactStore, params: SaveFileParams): SavedFileReceipt {
  const filename = params.filename.trim();
  const { content } = params;
  const { overwritten, shown } = store.save(filename, content, params.deliver === true);
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  return { filename, chars: content.length, lines, overwritten, shown };
}

type ArtifactsToolOptions = { emit: (event: AgentUiEvent) => void;  store?: ArtifactStore };

type Command = "create" | "update" | "rewrite" | "get" | "delete";

export function createAnswerUiGuideTool(): ToolDefinition {
  return defineTool({
    name: "answer_ui_guide",
    label: "Interface language",
    description: "Returns the language for writing an interactive answer in <ui>…</ui>. Call it once in a conversation, before the first <ui>.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: ANSWER_UI_GUIDE }], details: {} }),
  });
}

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
      "Create text files the user can download from the side panel: .csv, .md, .txt, .json, .html, .svg, .js, .css. Use it when the user asks for a file, an export, a document, a table to download, or a small standalone tool that needs nothing from the open page, and set deliver: true on that save: only then the file appears as a card with download/open buttons. Without deliver the file is a working file (for example one you will upload with upload_file): saved and readable here, but the user does not see it. Files are sealed: they cannot read the open page or its captions or control its video, so do not promise that. An HTML card also has an opt-in in-conversation interactive preview in an isolated sandbox. HTML files run offline: external scripts, stylesheets, fonts, images and network requests are blocked, so inline all CSS and JavaScript, draw charts with inline SVG or canvas, and embed images as data: URLs. A clickable choice inside HTML may call window.parent.postMessage({sideagentResultChoice:1,label:'Route B'}, '*'); this only offers the user a button to put that text in their unsent input draft and never executes a browser action. Never claim a choice has been submitted until the user actually sends it. Commands: create (filename + content; fails if it exists), update (replace old_str with new_str; preferred for small edits), rewrite (replace the whole content), get (read it back), delete. Files live only in this conversation. For CSV include a header row. Do not retype large data you already obtained with tools (page or API extraction longer than a few thousand characters): build the file inside browser_run with browser.saveFile({filename, content}) instead; pass deliver: true there too when the user asked for the file; it lands in this same file list, and you can get or update it here afterwards. Binary formats (pdf, docx, xlsx) are not supported.",
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
