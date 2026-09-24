/**
 * 在不依赖 pi-coding-agent 运行时的地方（扩展里的循环）执行我们的 Pi 扩展钩子。
 *
 * 只实现我们三个钩子（tool-failure-policy、memory-runtime、product-context）实际用到的部分：
 * `pi.on` 的 input / context / before_agent_start / tool_call / tool_result，`pi.getActiveTools`、`pi.getAllTools`，
 * 以及回调里的 `ctx.abort`。组合规则照 pi-coding-agent 0.84.4 的 ExtensionRunner（dist/core/extensions/runner.js）：
 * - before_agent_start、context、tool_result：按注册顺序接力，后一个收到前一个改过的值；
 * - tool_call：第一个返回 block 的钩子立即生效；
 * - 除 tool_call 外，钩子抛错只记录，不中断任务。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Handler = (event: HookEvent, ctx: HookContext) => HookResult | void | Promise<HookResult | void>;

/** 钩子收到的事件：各事件只用到这里列出的字段。 */
export interface HookEvent {
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

export interface HookResult {
  systemPrompt?: string;
  messages?: readonly HookMessage[];
  block?: boolean;
  reason?: string;
  content?: readonly HookContent[];
  details?: HookValue;
  isError?: boolean;
}

export interface HookContext { abort(): void }

export type HookValue = string | number | boolean | null | undefined | readonly HookValue[] | { readonly [key: string]: HookValue };

export interface HookArgs { readonly [key: string]: HookValue }

export interface HookContent { type: string; text?: string }

export interface HookMessage { role: string; customType?: string; content?: HookValue; timestamp?: number; display?: boolean }

/** 钩子能看到的工具信息。 */
export interface HookTool { name: string; description: string; parameters: HookValue; promptGuidelines?: readonly string[] }

export interface ExtensionHostOptions {
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
      // SAFETY: 我们的三个钩子只调用 api 上的 on / getActiveTools / getAllTools（见文件头与 extension-host.test.ts）。
      void factory(api as never);
    }
  }

  has(event: string): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0;
  }

  async input(prompt: string): Promise<void> {
    await this.each("input", () => ({ type: "input", prompt }), () => {});
  }

  async beforeAgentStart(prompt: string, systemPrompt: string): Promise<string> {
    let current = systemPrompt;
    await this.each("before_agent_start", () => ({ type: "before_agent_start", prompt, systemPrompt: current }), result => {
      if (result.systemPrompt !== undefined) current = result.systemPrompt;
    });

    return current;
  }

  async context(messages: readonly HookMessage[]): Promise<readonly HookMessage[]> {
    let current: readonly HookMessage[] = structuredClone(messages);
    await this.each("context", () => ({ type: "context", messages: current }), result => {
      if (result.messages) current = result.messages;
    });

    return current;
  }

  /** 第一个 block 立即返回；钩子抛错按 Pi 的做法阻止执行。 */
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
