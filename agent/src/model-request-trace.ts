import { createHash } from "node:crypto";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { TraceRecorder } from "../../shared/run-trace-core.js";
import { warmUpSummary } from "./warm-connection.js";

export interface ModelRequestTool extends Tool {
  promptGuidelines?: readonly string[];
}

export interface ModelRequestObservation {
  systemPrompt: string;
  tools: readonly ModelRequestTool[];
  messages: readonly Message[];
  injected: ReadonlyArray<{ customType: string; text: string }>;
  effort?: string;
  promptWarm?: { sinceMs: number; ms: number | null; outcome: string };
  origin?: string;
}

const CHUNK_CHARS = 16_000;

const IMAGE_CACHE_MAX = 64;

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

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
    } catch {  }
  }

  response(status: number): void {
    try {
      this.record("response_headers", { status, sinceRequestMs: this.requestAt ? Date.now() - this.requestAt : null });
    } catch {  }
  }

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
