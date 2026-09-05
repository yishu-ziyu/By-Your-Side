import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "sideagent-acceptance";
const MODEL_ID = "continuity-v1";
export const ACCEPTANCE_MODEL = `${PROVIDER_ID}/${MODEL_ID}`;

type StreamEvent = Record<string, unknown>;

class LocalEventStream implements AsyncIterable<StreamEvent> {
  private readonly queue: StreamEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  private ended = false;
  private finalValue: unknown;
  private readonly finalPromise: Promise<unknown>;
  private resolveFinal!: (value: unknown) => void;

  constructor() {
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = resolve;
    });
  }

  push(event: StreamEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.queue.push(event);
  }

  end(value?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.finalValue = value;
    this.resolveFinal(value);
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  result(): Promise<unknown> {
    return this.finalPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end(this.finalValue);
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

const model = {
  id: MODEL_ID,
  name: "SideAgent acceptance continuity",
  api: "sideagent-acceptance",
  provider: PROVIDER_ID,
  baseUrl: "http://127.0.0.1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1_024,
};

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: unknown[], stopReason: string) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((part: any) => part?.text ?? part?.thinking ?? (part?.name ? `${part.name}:${JSON.stringify(part.arguments ?? {})}` : ""))
    .join("\n");
}

function taskIdFromContext(context: any): string | null {
  for (const message of context?.messages ?? []) {
    const match = messageText(message).match(/SIDEAGENT_ACCEPTANCE_TASK:([A-Za-z0-9._:-]+)/);
    if (match) return match[1] ?? null;
  }
  return null;
}

function lastUserText(context: any): string {
  const users = (context?.messages ?? []).filter((message: any) => message?.role === "user");
  return users.length > 0 ? messageText(users[users.length - 1]) : "";
}

function start(stream: LocalEventStream, content: unknown[] = []): any {
  const partial = assistant(content, "pending");
  stream.push({ type: "start", partial });
  return partial;
}

function finishText(stream: LocalEventStream, text: string, hold: boolean, signal?: AbortSignal): void {
  const partial = start(stream, [{ type: "text", text: "" }]);
  stream.push({ type: "text_start", contentIndex: 0, partial });
  partial.content[0].text = text;
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
  if (!hold) {
    const done = assistant([{ type: "text", text }], "stop");
    stream.push({ type: "done", reason: "stop", message: done });
    stream.end(done);
    return;
  }
  const abort = () => {
    const error = { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" };
    stream.push({ type: "error", reason: "aborted", error });
    stream.end(error);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
}

function deterministicStream(_requestModel: unknown, context: any, options?: { signal?: AbortSignal }): LocalEventStream {
  const stream = new LocalEventStream();
  queueMicrotask(() => {
    const taskId = taskIdFromContext(context);
    if (!taskId) {
      finishText(stream, "acceptance task missing", false, options?.signal);
      return;
    }
    const handback = lastUserText(context).includes("[HANDOFF BOUNDARY]");
    const last = context?.messages?.[context.messages.length - 1];
    if (!handback) {
      finishText(stream, `SIDEAGENT_ACCEPTANCE_ACTIVE:${taskId}`, true, options?.signal);
      return;
    }
    if (last?.role === "toolResult" && last.toolName === "snapshot") {
      finishText(stream, `SIDEAGENT_ACCEPTANCE_CONTINUED:${taskId}`, true, options?.signal);
      return;
    }
    const toolCall = {
      type: "toolCall",
      id: `acceptance-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: "snapshot",
      arguments: {},
    };
    const partial = start(stream, [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} }]);
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    const done = assistant([toolCall], "toolUse");
    stream.push({ type: "done", reason: "toolUse", message: done });
    stream.end(done);
  });
  return stream;
}

/** 仅在一次性能力令牌通过后调用；不注册到普通启动路径。 */
export function registerAcceptanceModel(runtime: ModelRuntime): string {
  if (!runtime.getProvider(PROVIDER_ID)) {
    runtime.registerNativeProvider({
      id: PROVIDER_ID,
      name: "SideAgent local acceptance",
      auth: { apiKey: { name: "Local acceptance", resolve: async () => ({ auth: {} }) } },
      getModels: () => [model],
      stream: deterministicStream,
      streamSimple: deterministicStream,
    } as unknown as Parameters<ModelRuntime["registerNativeProvider"]>[0]);
  }
  return ACCEPTANCE_MODEL;
}
