import { randomUUID, createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import {
  USER_DELIVERY_TEXT_MAX,
  isUserDelivery,
  type UserDelivery,
  type UserDeliveryKind,
  type VoiceConversationContext,
} from "../../shared/voice.js";

export const deliveryMetrics = { composeCalls: 0, composeMs: [] as number[], toolCalls: 0, toolRejected: 0 };
export const toolDeliveryId = (id: string) => `delivery-${createHash('sha256').update(id).digest('hex').slice(0,32)}`;

export function resetDeliveryMetrics(): void {
  deliveryMetrics.composeCalls = 0;
  deliveryMetrics.composeMs = [];
  deliveryMetrics.toolCalls = 0;
  deliveryMetrics.toolRejected = 0;
}

const RECORD_KINDS = ["ack", "finding", "reply"] as const;
const HOST_TOOL_KINDS = ["ack", "finding"] as const;

/** Lead has a conversationId; fleet workers do not. Memory store is unrelated. */
export function isLeadDeliveryHost(conversationId?: string): boolean {
  return typeof conversationId === "string" && conversationId.length > 0;
}

export function createUserDelivery(input: {
  conversationId: string;
  runId: string | null;
  kind: UserDeliveryKind;
  text: string;
  replyTo?: string;
  id?: string;
  composedAt?: number;
  status?: UserDelivery["status"];
}): UserDelivery {
  const delivery = {
    conversationId: input.conversationId,
    id: input.id ?? randomUUID(),
    runId: input.runId,
    kind: input.kind,
    text: input.text,
    composedAt: input.composedAt ?? Date.now(),
    status: input.status ?? "composed",
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  } as UserDelivery;
  if (!RECORD_KINDS.includes(input.kind as (typeof RECORD_KINDS)[number])) throw new Error("kind 必须是 ack、finding 或 reply。");
  if (input.runId !== null && !isUserDelivery(delivery)) throw new Error("正式回答格式无效，请改写成不超过2000字的完整句子，不要截断末尾。");
  if (!delivery.text || delivery.text.length > USER_DELIVERY_TEXT_MAX) {
    throw new Error("正式回答格式无效，请改写成不超过2000字的完整句子，不要截断末尾。");
  }
  return delivery;
}

export function assertDeliveryText(text: string): string {
  const clean = String(text ?? "").trim();
  if (!clean) throw new Error("正式回答不能为空，请重写要对人说的完整句子。");
  if (clean.length > USER_DELIVERY_TEXT_MAX) throw new Error("正式回答过长，请改写成不超过2000字的完整句子，不要截断末尾范围。");
  return clean;
}

export function createSendUserMessageTool(opts: {
  conversationId: string;
  getRunId: () => string | null;
  emit: (event: AgentUiEvent) => void;
  clock?: () => number;
}): ToolDefinition {
  return defineTool({
    name: "send_user_message",
    label: "Send a user-facing message",
    description:
      "Send the exact words the user should see and hear. Tool results and ordinary assistant text are internal work. Use kind=finding for the final task result, or kind=ack for a start acknowledgement. Do not use this tool for follow-up answers. An acknowledgement is not the final result. Do not claim independent verification. Keep the message short, usually one to three spoken sentences, naming concrete findings and any unread or unconfirmed limits.",
    parameters: Type.Object({
      kind: Type.Unsafe<"ack" | "finding">(Type.String({ description: "ack or finding. Final task results must be finding, not reply." })),
      content: Type.String({ description: "Exact user-facing text. Do not truncate trailing limits." }),
      reply_to: Type.Optional(Type.String({ description: "Optional user utterance or previous delivery id this answers" })),
    }),
    execute: async (_id, params) => {
      deliveryMetrics.toolCalls += 1;
      try {
        const kind = params.kind;
        if (!HOST_TOOL_KINDS.includes(kind as (typeof HOST_TOOL_KINDS)[number])) {
          throw new Error("kind 必须是 ack 或 finding。任务最终结果用 finding，不要发 reply。");
        }
        const text = assertDeliveryText(String(params.content ?? ""));
        const runId = opts.getRunId();
        if (!runId) throw new Error("当前没有可绑定的任务，未交付。");
        const replyTo = params.reply_to == null ? undefined : String(params.reply_to).trim() || undefined;
        if (replyTo !== undefined && (replyTo.length < 1 || replyTo.length > USER_DELIVERY_TEXT_MAX)) {
          throw new Error("reply_to 无效，请省略或给出完整引用，不要截断。");
        }
        const delivery = createUserDelivery({
          id: toolDeliveryId(_id),
          conversationId: opts.conversationId,
          runId,
          kind: kind as UserDeliveryKind,
          text,
          replyTo,
          composedAt: (opts.clock ?? Date.now)(),
        });
        opts.emit({ kind: "user_delivery", delivery });
        return { content: [{ type: "text" as const, text: `delivered:${delivery.id}` }], details: { id: delivery.id } };
      } catch (error) {
        deliveryMetrics.toolRejected += 1;
        throw error;
      }
    },
  });
}

export const COMPOSE_USER_DELIVERY_PROMPT =
  "你根据来源事实组织一句给用户的正式回答。通常1至3句自然中文口语。先说具体发现，保留读取范围与未确认部分。来源是助手报告，不是独立核验成功。不要改写来源里的实体关系。不要Markdown、内部ID或工具名。只输出要对人说的正文。";

export function composeUserDeliveryInput(input: {
  question?: string | null;
  facts: string;
  recentTurns: VoiceConversationContext["recentTurns"];
  latestDelivery?: UserDelivery | null;
}): string {
  return JSON.stringify({
    question: input.question ?? null,
    facts: input.facts,
    recentTurns: input.recentTurns,
    latestDelivery: input.latestDelivery ? { kind: input.latestDelivery.kind, text: input.latestDelivery.text } : null,
  });
}
