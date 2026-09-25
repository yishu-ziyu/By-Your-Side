/**
 * 会话里的文件（产物）：模型写出 CSV、Markdown、HTML 等文本文件，侧栏显示成卡片，用户点一下下载。
 * 命令沿用 Pi web-ui 的 artifacts 工具约定（create / update / rewrite / get / delete），模型对它已熟悉；
 * 文件只存在本会话内存，每次改动都发 `artifact` 事件，侧栏据此画卡片。见 docs/evals/20260925-artifacts-files.md。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { defineTool } from "./define-tool.js";

/** 单个文件上限：侧栏历史要能回放，超大内容会挤掉其他记录。 */
export const ARTIFACT_MAX_CHARS = 256_000;

/** 只接受一层文件名：不许带目录、不许以点开头，扩展名决定侧栏怎么显示与下载。 */
const FILENAME = /^[^/\\:*?"<>|.][^/\\:*?"<>|]{0,99}\.[A-Za-z0-9]{1,8}$/;

export type ArtifactsToolOptions = { emit: (event: AgentUiEvent) => void };

type Command = "create" | "update" | "rewrite" | "get" | "delete";

export function createArtifactsTool(opts: ArtifactsToolOptions): ToolDefinition {
  const files = new Map<string, string>();

  const listed = () => (files.size ? `现有文件：${[...files.keys()].join("、")}` : "本会话还没有文件。");

  const save = (filename: string, content: string, verb: string) => {
    if (content.length > ARTIFACT_MAX_CHARS) throw new Error(`文件过大（${content.length} 字符，上限 ${ARTIFACT_MAX_CHARS}），未保存。请拆成多个文件或精简内容。`);
    files.set(filename, content);
    opts.emit({ kind: "artifact", action: "saved", filename, content });

    return `${verb} ${filename}（${content.length} 字符），侧栏已显示文件卡片，用户可点击下载。`;
  };

  return defineTool({
    name: "artifacts",
    label: "Files for the user",
    description:
      "Create text files the user can download from the side panel: .csv, .md, .txt, .json, .html, .svg, .js, .css. Use it when the user asks for a file, an export, a document, a table to download, or a small standalone tool. The file appears as a card with a download button; you do not trigger downloads yourself. Commands: create (filename + content; fails if it exists), update (replace old_str with new_str; preferred for small edits), rewrite (replace the whole content), get (read it back), delete. Files live only in this conversation. For CSV include a header row. Binary formats (pdf, docx, xlsx) are not supported.",
    parameters: Type.Object({
      command: Type.Unsafe<Command>(Type.String({ description: "create, update, rewrite, get or delete" })),
      filename: Type.String({ description: "File name with extension, no folders, e.g. products.csv" }),
      content: Type.Optional(Type.String({ description: "Full file content, for create and rewrite" })),
      old_str: Type.Optional(Type.String({ description: "Exact text to replace, for update" })),
      new_str: Type.Optional(Type.String({ description: "Replacement text, for update" })),
    }),
    execute: async (_id, params) => {
      const filename = String(params.filename ?? "").trim();

      if (!FILENAME.test(filename)) throw new Error(`文件名无效：${JSON.stringify(filename)}。只用一层文件名并带扩展名，例如 products.csv。`);
      const existing = files.get(filename);
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
          files.delete(filename);
          opts.emit({ kind: "artifact", action: "deleted", filename });
          text = `已删除 ${filename}。`;
          break;
        default:
          throw new Error(`未知命令 ${String(params.command)}；可用 create、update、rewrite、get、delete。`);
      }

      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
