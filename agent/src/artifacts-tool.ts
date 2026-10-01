/**
 * 会话里的文件（产物）：模型写出 CSV、Markdown、HTML 等文本文件，侧栏显示成卡片，用户点一下下载。
 * 命令沿用 Pi web-ui 的 artifacts 工具约定（create / update / rewrite / get / delete），模型对它已熟悉；
 * 文件只存在本会话内存，每次改动都发 `artifact` 事件，侧栏据此画卡片。见 docs/evals/20260925-artifacts-files.md。
 * `browser_run` 的 `browser.saveFile` 写进同一文件区，工具拿到的大段数据不经模型重打（docs/evals/20261001-data-to-file.md）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { defineTool } from "./define-tool.js";

/** 单个文件上限：侧栏历史要能回放，超大内容会挤掉其他记录。 */
export const ARTIFACT_MAX_CHARS = 256_000;

/** 只接受一层文件名：不许带目录、不许以点开头，扩展名决定侧栏怎么显示与下载。 */
const FILENAME = /^[^/\\:*?"<>|.][^/\\:*?"<>|]{0,99}\.[A-Za-z0-9]{1,8}$/;

/**
 * 本会话的文件区：`artifacts` 工具与 `browser_run` 里的 `browser.saveFile` 共用同一份，
 * 规则（文件名、大小）与侧栏卡片事件只在这里一处。
 */
export interface ArtifactStore {
  get(filename: string): string | undefined;
  names(): string[];
  /** 校验文件名与大小后保存并发 `artifact` 事件；返回是否覆盖了同名文件。 */
  save(filename: string, content: string): { overwritten: boolean };
  delete(filename: string): boolean;
}

export function assertArtifactFilename(filename: string): void {
  if (!FILENAME.test(filename)) throw new Error(`文件名无效：${JSON.stringify(filename)}。只用一层文件名并带扩展名，例如 products.csv。`);
}

export function createArtifactStore(emit: (event: AgentUiEvent) => void): ArtifactStore {
  const files = new Map<string, string>();

  return {
    get: filename => files.get(filename),
    names: () => [...files.keys()],
    save(filename, content) {
      assertArtifactFilename(filename);

      if (content.length > ARTIFACT_MAX_CHARS) throw new Error(`文件过大（${content.length} 字符，上限 ${ARTIFACT_MAX_CHARS}），未保存。请拆成多个文件或精简内容。`);
      const overwritten = files.has(filename);
      files.set(filename, content);
      emit({ kind: "artifact", action: "saved", filename, content });

      return { overwritten };
    },
    delete(filename) {
      if (!files.delete(filename)) return false;
      emit({ kind: "artifact", action: "deleted", filename });

      return true;
    },
  };
}

/** 程序里存文件的回执：只有文件名与长度，内容不回到模型上下文。 */
export type SavedFileReceipt = { filename: string; chars: number; lines: number; overwritten: boolean };

const SAVE_FILE_PARAMS = Type.Object({ filename: Type.String(), content: Type.String({ minLength: 1 }) });

export type SaveFileParams = Static<typeof SAVE_FILE_PARAMS>;

/** 程序传来的是 JSON；按 schema 认，不把数组、对象或空内容悄悄转成文本。 */
export function isSaveFileParams(value: unknown): value is SaveFileParams {
  return Check(SAVE_FILE_PARAMS, value);
}

export function rejectSaveFileParams(): never {
  throw new Error("INVALID_ARGUMENT: saveFile 需要 {filename: 字符串, content: 非空字符串}；表格或对象先在程序里拼成 CSV/JSON 文本，空内容不保存。");
}

/** `browser.saveFile({filename, content})` 的宿主实现：与 `artifacts` 同一文件区、同一规则、同一张卡片。 */
export function saveFileFromProgram(store: ArtifactStore, params: SaveFileParams): SavedFileReceipt {
  const filename = params.filename.trim();
  const { content } = params;
  const { overwritten } = store.save(filename, content);
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

  return { filename, chars: content.length, lines, overwritten };
}

export type ArtifactsToolOptions = { emit: (event: AgentUiEvent) => void; /** 与 browser_run 共用时传入；不传则自建。 */ store?: ArtifactStore };

type Command = "create" | "update" | "rewrite" | "get" | "delete";

export function createArtifactsTool(opts: ArtifactsToolOptions): ToolDefinition {
  const store = opts.store ?? createArtifactStore(opts.emit);
  const names = store.names;

  const listed = () => (names().length ? `现有文件：${names().join("、")}` : "本会话还没有文件。");

  const save = (filename: string, content: string, verb: string) => {
    store.save(filename, content);

    return `${verb} ${filename}（${content.length} 字符），侧栏已显示文件卡片，用户可点击下载。`;
  };

  return defineTool({
    name: "artifacts",
    label: "Files for the user",
    description:
      "Create text files the user can download from the side panel: .csv, .md, .txt, .json, .html, .svg, .js, .css. Use it when the user asks for a file, an export, a document, a table to download, or a small standalone tool. The file appears as a card with a download button; you do not trigger downloads yourself. Commands: create (filename + content; fails if it exists), update (replace old_str with new_str; preferred for small edits), rewrite (replace the whole content), get (read it back), delete. Files live only in this conversation. For CSV include a header row. Do not retype large data you already obtained with tools (page or API extraction longer than a few thousand characters): build the file inside browser_run with browser.saveFile({filename, content}) instead; it lands in this same file list, shows the same card, and you can get or update it here afterwards. Binary formats (pdf, docx, xlsx) are not supported.",
    parameters: Type.Object({
      command: Type.Unsafe<Command>(Type.String({ description: "create, update, rewrite, get or delete" })),
      filename: Type.String({ description: "File name with extension, no folders, e.g. products.csv" }),
      content: Type.Optional(Type.String({ description: "Full file content, for create and rewrite" })),
      old_str: Type.Optional(Type.String({ description: "Exact text to replace, for update" })),
      new_str: Type.Optional(Type.String({ description: "Replacement text, for update" })),
    }),
    execute: async (_id, params) => {
      const filename = String(params.filename ?? "").trim();

      assertArtifactFilename(filename);
      const existing = store.get(filename);
      let text: string;

      switch (params.command) {
        case "create":
          if (existing !== undefined) throw new Error(`${filename} 已存在；改动用 update 或 rewrite。`);

          if (!params.content) throw new Error("create 需要 content。");
          text = save(filename, params.content, "已创建");
          break;
        case "update":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);

          if (!params.old_str || params.new_str === undefined) throw new Error("update 需要 old_str 和 new_str。");

          if (!existing.includes(params.old_str)) throw new Error(`${filename} 里找不到要替换的文字。当前全文：\n\n${existing}`);
          text = save(filename, existing.replace(params.old_str, params.new_str), "已修改");
          break;
        case "rewrite":
          if (existing === undefined) throw new Error(`找不到 ${filename}。${listed()}`);

          if (!params.content) throw new Error("rewrite 需要 content。");
          text = save(filename, params.content, "已重写");
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

      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
