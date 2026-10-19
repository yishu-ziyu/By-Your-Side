import { createHash } from "node:crypto";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { TraceRecorder } from "../../shared/run-trace-core.js";
import { warmUpSummary } from "./warm-connection.js";

/**
 * 每次模型调用的请求指纹：
 * 系统提示词和工具说明记 sha256 与字数，同一诊断会话里第一次出现时分段写全文；
 * 宿主插入的上下文消息记原文（脱敏照常）；图片只记原始字节的 sha256、类型和字节数，不存像素。
 * 只观察：任何异常都吞掉，不影响模型调用。
 */

/** 模型这次实际收到的工具说明（名字、说明、参数表；有提示词准则时一并带上）。 */
export interface ModelRequestTool extends Tool {
  promptGuidelines?: readonly string[];
}

/** 模型这次实际收到的请求；injected 是本次请求里宿主插入的上下文消息（custom 消息）。 */
export interface ModelRequestObservation {
  systemPrompt: string;
  tools: readonly ModelRequestTool[];
  messages: readonly Message[];
  injected: ReadonlyArray<{ customType: string; text: string }>;
  /** 这次调用用的思考档。 */
  effort?: string;
  /** 这个对话最近一次预热前缀缓存（DurableAgentLoop.warmPromptCache）：发出到这次请求多少毫秒、用了多久、结果；没预热过时没有。 */
  promptWarm?: { sinceMs: number; ms: number | null; outcome: string };
  /** 模型服务的 origin，用来对上提前建连接的记录；只写进诊断的是摘要，不写地址。 */
  origin?: string;
}

/** 全文分段字数：远低于脱敏的单串上限（64k 字）与单行上限（256 KB，最坏每字 6 字节转义也不到 100 KB）。 */
const CHUNK_CHARS = 16_000;

/** 同一张图在每次调用里都会重发：按 base64 原串缓存指纹，避免反复计算。 */
const IMAGE_CACHE_MAX = 64;

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

/** 工具说明全文里的一项：名字、说明、参数表，有提示词准则时才带上。 */
function manifestEntry(tool: ModelRequestTool): ModelRequestTool {
  const entry: ModelRequestTool = { name: tool.name, description: tool.description, parameters: tool.parameters };

  if (tool.promptGuidelines?.length) entry.promptGuidelines = tool.promptGuidelines;

  return entry;
}

type ImageRef = { sha256: string; mimeType: string; bytes: number };

export class ModelRequestTrace {
  private readonly written = new Set<string>();
  private readonly imageCache = new Map<string, { sha256: string; bytes: number }>();
  private requestAt = 0;

  constructor(private readonly record: (...args: Parameters<TraceRecorder["record"]>) => void) {}

  observe(request: ModelRequestObservation): void {
    try {
      this.requestAt = Date.now();
      const systemPromptSha256 = sha256Text(request.systemPrompt);
      const manifest = JSON.stringify(request.tools.map(manifestEntry));
      const toolsSha256 = sha256Text(manifest);

      this.writeOnce("system_prompt", systemPromptSha256, request.systemPrompt);
      this.writeOnce("tools_manifest", toolsSha256, manifest);

      this.record("model_request", {
        systemPromptSha256, systemPromptChars: request.systemPrompt.length,
        toolsSha256, toolCount: request.tools.length, effort: request.effort,
        injected: request.injected.map(item => ({ customType: item.customType, text: item.text })),
        images: this.images(request.messages),
        warmUp: warmUpSummary(request.origin, this.requestAt),
        ...(request.promptWarm ? { promptWarm: request.promptWarm } : {}),
      });
    } catch { /* Diagnostics must never interrupt the model call. */ }
  }

  /** 响应头到了（fetch 返回），和第一个流事件（first_response）分开记：前者含建连接，后者还含服务端排队和思考。 */
  response(status: number): void {
    try {
      this.record("response_headers", { status, sinceRequestMs: this.requestAt ? Date.now() - this.requestAt : null });
    } catch { /* Diagnostics must never interrupt the model call. */ }
  }

  /** 全文按 sha256 只写一次：chunk 依 index 顺序拼回即原文（脱敏后）。 */
  private writeOnce(type: "system_prompt" | "tools_manifest", sha256: string, text: string): void {
    const key = `${type}:${sha256}`;

    if (this.written.has(key)) return;
    this.written.add(key);
    const total = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));

    for (let index = 0; index < total; index += 1) {
      this.record(type, { sha256, index, total, chars: text.length, text: text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) });
    }
  }

  private images(messages: ModelRequestObservation["messages"]): ImageRef[] {
    const images: ImageRef[] = [];

    for (const message of messages) {
      if (message.role === "assistant" || !Array.isArray(message.content)) continue;

      for (const part of message.content) {
        if (part.type !== "image") continue;
        let print = this.imageCache.get(part.data);

        if (!print) {
          const bytes = base64Bytes(part.data);
          print = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };

          if (this.imageCache.size >= IMAGE_CACHE_MAX) this.imageCache.delete(this.imageCache.keys().next().value!);
          this.imageCache.set(part.data, print);
        }

        images.push({ sha256: print.sha256, mimeType: part.mimeType, bytes: print.bytes });
      }
    }

    return images;
  }
}
