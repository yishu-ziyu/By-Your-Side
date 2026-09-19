import { randomUUID, createHash } from "node:crypto";
import { VOICE_PERSONALITY } from './voice-personality.js';
import {nextStepInstruction, partialResultNote, type TaskNextStep} from '../../shared/task-next-step.js';
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import {
  USER_DELIVERY_TEXT_MAX,
  isUserDelivery,
  isUserDeliveryFacts,
  type UserDelivery,
  type UserDeliveryFacts,
  type UserDeliveryKind,
  type UserDeliveryRemainingItem,
  type UserDeliverySourceRef,
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

/** 宿主提供的事实链投影输入；outcome 由工具按已校验的 nextStep 决定，不由模型或宿主自报。 */
export interface DeliveryFactInput {
  delivered: string[];
  remaining: UserDeliveryRemainingItem[];
  sources: UserDeliverySourceRef[];
}

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
  facts?: UserDeliveryFacts;
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
    ...(input.facts ? { facts: input.facts } : {}),
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
  /** 还有未完成步骤时，finding 不得提前 terminate。 */
  hasUnfinishedWork?: () => boolean;
  /** Bound to the current host snapshot, never to model-authored completion flags. */
  getNextStep?: () => TaskNextStep | null;
  /** 宿主事实链：已满足项、未完成项、本 run 真实读到的页面；未接线时不附 facts。 */
  getDeliveryFacts?: () => DeliveryFactInput | null;
}): ToolDefinition {
  return defineTool({
    name: "send_user_message",
    label: "Send a user-facing message",
    description:
      "Send the exact words the user should see and hear. Tool results and ordinary assistant text are internal work. Use kind=finding for the final task result, or kind=ack for a start acknowledgement. For a finding, outcome=complete (default) requires no outstanding results and a real post-action page readback; outcome=partial honestly reports unfinished, blocked or unverified work and ends this turn without clearing the ledger. Never claim completion in a partial report. Do not use this tool for follow-up answers. An acknowledgement is not the final result. Do not claim independent verification. Keep simple outcomes short. For substantial written results, lead with the finding, use focused paragraphs and useful headings, and cite exact source URLs through descriptive Markdown links. Do not force headings on short replies. Preserve requested detail and any unread or unconfirmed limits.",
    parameters: Type.Object({
      kind: Type.Unsafe<"ack" | "finding">(Type.String({ description: "ack or finding. Final task results must be finding, not reply." })),
      content: Type.String({ description: "Exact user-facing text. Do not truncate trailing limits." }),
      outcome: Type.Optional(Type.Union([Type.Literal('complete'),Type.Literal('partial')],{description:'For finding: complete requires current execution and readback evidence; partial reports limits and stops without marking unfinished work complete.'})),
      reply_to: Type.Optional(Type.String({ description: "Optional user utterance or previous delivery id this answers" })),
    }),
    execute: async (_id, params) => {
      deliveryMetrics.toolCalls += 1;
      try {
        const kind = params.kind;
        if (!HOST_TOOL_KINDS.includes(kind as (typeof HOST_TOOL_KINDS)[number])) {
          throw new Error("kind 必须是 ack 或 finding。任务最终结果用 finding，不要发 reply。");
        }
        let text = assertDeliveryText(String(params.content ?? ""));
        const outcome=params.outcome??'complete';
        if(!['complete','partial'].includes(outcome))throw new Error('outcome 必须是 complete 或 partial。');
        const next=kind==='finding'?opts.getNextStep?.():undefined;
        if(kind==='finding'&&opts.getNextStep&&!next)throw new Error('当前任务判断尚未接线，未交付。');
        if(next?.delivery==='none')throw new Error(nextStepInstruction(next));
        if(next&&outcome==='complete'&&next.delivery!=='report'){
          throw new Error(`${nextStepInstruction(next)}不能交付为完整结果；确实无法继续时请用 outcome=partial 说明已完成和未确认部分。`);
        }
        if(kind==='finding'&&outcome==='partial'){
          text=assertDeliveryText(`${text}\n\n${next?partialResultNote(next):'任务状态：仅交付部分结果，未声明全部完成。'}`);
        }
        const runId = opts.getRunId();
        if (!runId) throw new Error("当前没有可绑定的任务，未交付。");
        const replyTo = params.reply_to == null ? undefined : String(params.reply_to).trim() || undefined;
        if (replyTo !== undefined && (replyTo.length < 1 || replyTo.length > USER_DELIVERY_TEXT_MAX)) {
          throw new Error("reply_to 无效，请省略或给出完整引用，不要截断。");
        }
        // 事实链字段只从宿主投影；模型正文写不进这里，缺接线时保持旧记录形状。
        const hostFacts = kind === "finding" ? opts.getDeliveryFacts?.() ?? null : null;
        const facts: UserDeliveryFacts | undefined = hostFacts
          ? { outcome, delivered: hostFacts.delivered, remaining: hostFacts.remaining, sources: hostFacts.sources }
          : undefined;
        if (facts && !isUserDeliveryFacts(facts)) {
          throw new Error("交付事实链无效（未完成项与 outcome 不一致或字段超界），本次未交付。");
        }
        const delivery = createUserDelivery({
          id: toolDeliveryId(_id),
          conversationId: opts.conversationId,
          runId,
          kind: kind as UserDeliveryKind,
          text,
          replyTo,
          composedAt: (opts.clock ?? Date.now)(),
          ...(facts ? { facts } : {}),
        });
        opts.emit({ kind: "user_delivery", delivery });
        return {
          content: [{ type: "text" as const, text: `delivered:${delivery.id}` }],
          details: { id: delivery.id, ...(next?{outcome,nextAction:next.action,resultIds:next.resultIds}:{}) },
          // finding 就是任务的最终结果：这一批工具结果带 terminate 后，SDK 的批次早停规则
          // 让本轮结束，不再为"还要不要收尾"多问模型一次（省 1–3s）。
          // ack 只是开场应答，提前终止会掐断任务，因此不参与早停。
          terminate: kind === "finding" && (next ? true : !opts.hasUnfinishedWork?.()),
        };
      } catch (error) {
        deliveryMetrics.toolRejected += 1;
        throw error;
      }
    },
  });
}

export const COMPOSE_USER_DELIVERY_PROMPT =
  "你根据来源事实组织一句给用户的正式回答。通常1至3句自然中文口语。先说具体发现，保留读取范围与未确认部分。来源是助手报告，不是独立核验成功。不要改写来源里的实体关系。不要Markdown、内部ID或工具名。只输出要对人说的正文。" + VOICE_PERSONALITY;

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
