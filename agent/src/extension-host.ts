import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type Handler = (event: HookEvent, ctx: HookContext) => HookResult | void | Promise<HookResult | void>;

interface HookEvent {
  type: string;
  systemPrompt?: string;
  messages?: readonly HookMessage[];
  toolName?: string;
  toolCallId?: string;
  input?: HookArgs;
  content?: readonly HookContent[];
  details?: HookValue;
  isError?: boolean;
  prompt?: string;
}

interface HookResult {
  systemPrompt?: string;
  message?: { customType: string; content?: HookValue; display?: boolean };
  messages?: readonly HookMessage[];
  block?: boolean;
  reason?: string;
  content?: readonly HookContent[];
  details?: HookValue;
  isError?: boolean;
}

export const OBSERVED_EVENTS: ReadonlySet<string> = new Set([
  "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
]);

interface HookContext { abort(): void }

export type HookValue = string | number | boolean | null | undefined | readonly HookValue[] | { readonly [key: string]: HookValue };

export interface HookArgs { readonly [key: string]: HookValue }

type HookContent = TextContent | ImageContent;

export interface HookMessage { role: string; customType?: string; content?: HookValue; timestamp?: number; display?: boolean }

interface HookTool { name: string; description: string; parameters: TSchema; promptGuidelines?: readonly string[] }

interface ExtensionHostOptions {
  factories: readonly ExtensionFactory[];
  allTools: () => readonly HookTool[];
  activeToolNames: () => readonly string[];
  abort: () => void;
  onError?: (event: string, message: string) => void;
}

export class ExtensionHost {
  private readonly handlers = new Map<string, Handler[]>();
  private readonly ctx: HookContext;

  constructor(private readonly options: ExtensionHostOptions) {
    this.ctx = { abort: () => options.abort() };

    const api = {
      on: (event: string, handler: Handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      getActiveTools: () => [...options.activeToolNames()],
      getAllTools: () => [...options.allTools()],
    };

    for (const factory of options.factories) {
      void factory(api as never);
    }
  }

  has(event: string): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0;
  }

  async input(prompt: string): Promise<void> {
    await this.each("input", () => ({ type: "input", prompt }), () => {});
  }

  async beforeAgentStart(prompt: string, systemPrompt: string): Promise<{ systemPrompt: string; context: string[] }> {
    let current = systemPrompt;
    const context: string[] = [];
    await this.each("before_agent_start", () => ({ type: "before_agent_start", prompt, systemPrompt: current }), result => {
      if (result.systemPrompt !== undefined) current = result.systemPrompt;

      if (typeof result.message?.content === "string" && result.message.content) context.push(result.message.content);
    });

    return { systemPrompt: current, context };
  }

  async context(messages: readonly HookMessage[]): Promise<readonly HookMessage[]> {
    let current: readonly HookMessage[] = structuredClone(messages);
    await this.each("context", () => ({ type: "context", messages: current }), result => {
      if (result.messages) current = result.messages;
    });

    return current;
  }

  async toolCall(toolName: string, toolCallId: string, input: HookArgs): Promise<HookResult | undefined> {
    let result: HookResult | undefined;

    for (const handler of this.handlers.get("tool_call") ?? []) {
      const handlerResult = await handler({ type: "tool_call", toolName, toolCallId, input }, this.ctx);

      if (!handlerResult) continue;
      result = handlerResult;

      if (result.block) return result;
    }

    return result;
  }

  async toolResult(event: Required<Pick<HookEvent, "toolName" | "toolCallId" | "input" | "content" | "isError">> & Pick<HookEvent, "details">): Promise<HookResult | undefined> {
    const current: HookEvent = { type: "tool_result", ...event };
    let modified = false;
    await this.each("tool_result", () => current, result => {
      if (result.content !== undefined) { current.content = result.content; modified = true; }

      if (result.details !== undefined) { current.details = result.details; modified = true; }

      if (result.isError !== undefined) { current.isError = result.isError; modified = true; }
    });

    return modified ? { content: current.content, details: current.details, isError: current.isError } : undefined;
  }

  async notify(event: { type: string }): Promise<void> {
    if (!OBSERVED_EVENTS.has(event.type)) return;
    await this.each(event.type, () => event as HookEvent, () => {});
  }

  private async each(name: string, event: () => HookEvent, apply: (result: HookResult) => void): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) {
      try {
        const result = await handler(event(), this.ctx);

        if (result) apply(result);
      } catch (error) {
        this.options.onError?.(name, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
