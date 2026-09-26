import { randomUUID, createHash } from "node:crypto";
import { VOICE_PERSONALITY } from './voice-personality.js';
import {partialResultNote, type TaskNextStep} from '../../shared/task-next-step.js';
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import type { AgentUiEvent } from "../../shared/protocol.js";
import {
  USER_DELIVERY_TEXT_MAX,
  USER_DELIVERY_FACT_ITEM_MAX,
  USER_DELIVERY_FACT_DESCRIPTION_MAX,
  isUserDelivery,
  isUserDeliveryFacts,
  type UserDelivery,
  type UserDeliveryFacts,
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

/** 宿主投影包含完整截断计数；模型只能请求保守的部分交付，不能升级完成状态。 */
export type DeliveryFactInput = Omit<UserDeliveryFacts, "outcome"> & {pendingAnswers?:Array<{id:string;description:string}>};

/** Called only while constructing an actual delivery, never by status/voice progress queries. */
export function factsForDelivery(host:DeliveryFactInput,next:TaskNextStep|null|undefined):DeliveryFactInput {
  const {pendingAnswers,...facts}=host;

  if(next?.delivery!=='report'||!pendingAnswers?.length)return facts;
  const descriptions=[...new Set([...facts.delivered,...pendingAnswers.map(g=>g.description)])];

  return {...facts,delivered:descriptions.slice(0,USER_DELIVERY_FACT_ITEM_MAX),omittedDelivered:(facts.omittedDelivered??0)+Math.max(0,descriptions.length-USER_DELIVERY_FACT_ITEM_MAX),remaining:facts.remaining.filter(g=>!pendingAnswers.some(a=>a.id===g.id)),omittedRemaining:0};
}

/** 工具、普通正文补发及语音补发共用同一个事实投影。report 是报告许可，不是业务完成证明。 */
export function projectDeliveryFacts(host: DeliveryFactInput, next: TaskNextStep | null | undefined, requestPartial = false): UserDeliveryFacts {
  const remaining = host.remaining.length + (host.omittedRemaining ?? 0);
  let outcome: UserDeliveryFacts['outcome'];

  if (requestPartial || remaining > 0 || next?.delivery !== "report") {
    outcome = "partial";
  } else if (next.reason === "receipts_reviewed" && host.delivered.length > 0) {
    outcome = "complete";
  } else {
    outcome = "unverified";
  }

  const {pendingAnswers:_,...facts}=host;

  return { ...facts, outcome };
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
  unfinished?: string[];
}): UserDelivery {
  const delivery = {
    conversationId: input.conversationId,
    id: input.id ?? randomUUID(),
    runId: input.runId,
    kind: input.kind,
    text: input.text,
    composedAt: input.composedAt ?? Date.now(),
    status: input.status ?? "composed",
  } as UserDelivery;

  if (input.replyTo) delivery.replyTo = input.replyTo;

  if (input.facts) delivery.facts = input.facts;

  if (input.unfinished?.length) delivery.unfinished = input.unfinished;

  if (!RECORD_KINDS.includes(input.kind as (typeof RECORD_KINDS)[number])) throw new Error("kind 必须是 ack、finding 或 reply。");

  if (input.runId !== null && !isUserDelivery(delivery)) throw new Error("正式回答格式无效，请改写成不超过12000字的完整句子，不要截断末尾。");

  if (!delivery.text || delivery.text.length > USER_DELIVERY_TEXT_MAX) {
    throw new Error("正式回答格式无效，请改写成不超过12000字的完整句子，不要截断末尾。");
  }

  return delivery;
}

export function assertDeliveryText(text: string): string {
  const clean = String(text ?? "").trim();

  if (!clean) throw new Error("正式回答不能为空，请重写要对人说的完整句子。");

  if (clean.length > USER_DELIVERY_TEXT_MAX) throw new Error("正式回答过长，请改写成不超过12000字的完整句子，不要截断末尾范围。");

  return clean;
}

export type SendUserMessageOptions = {
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
  /** 没了结的只剩等用户在页面上确认的动作时返回它们；否则 null。 */
  getAwaitingConfirmation?: () => { items: Array<{ id: string; description: string }>; others: number } | null;
  /** 本轮尝试改页面的次数与真正生效的次数；未接线时不做这项纠正。 */
  getPageChanges?: () => PageChangeTally | null;
};

/** 一轮里改页面的尝试次数与真正生效的次数（宿主按工具结果计，不看正文）。 */
export type PageChangeTally = { attempts: number; changes: number };

/** 有动作被拦下等用户在页面上确认时补的一句：它没失败，也不是结果未知，是在等你。others 是另外没了结的执行项数。 */
export function awaitingConfirmationNote(awaiting: { items: ReadonlyArray<{ description: string }>; others: number }): string {
  const first = awaiting.items[0]?.description ?? "这一步";
  const more = awaiting.items.length > 1 ? ` 等 ${awaiting.items.length} 步` : "";

  return `（还等你在页面上确认：${first}${more}。${awaiting.others ? "另外还有没做成的步骤。" : ""}）`;
}

/** 尝试过改页面、一次都没生效时补在回答后的事实。 */
export function pageUnchangedNote(attempts: number): string {
  return `页面没有变化：本轮 ${attempts} 次改动页面的尝试都没有生效。`;
}

/**
 * 把一段要对人说的话交给用户。只拒绝格式无效的正文；账本里仍有未完成或未核验的项时，
 * 照常交付并改标为 partial、附上宿主的未完成说明，由用户判断，而不是扣下回答。
 */
/** 交付结果与宿主实际判定的完成度（模型请求 complete 也可能被标成 partial）。 */
export type DeliveredMessage = { delivery: UserDelivery; outcome: "complete" | "partial" };

/** 模型列出的未完成项：去空、截长、限条数；格式不对的整体忽略，不因此拒绝交付。 */
function cleanUnfinished(raw: string[] | undefined): string[] {
  if (!raw) return [];

  const items = raw.map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.length > USER_DELIVERY_FACT_DESCRIPTION_MAX ? `${item.slice(0, USER_DELIVERY_FACT_DESCRIPTION_MAX - 1)}…` : item));

  return [...new Set(items)].slice(0, USER_DELIVERY_FACT_ITEM_MAX);
}

export function deliverUserMessage(opts: SendUserMessageOptions, input: { id: string; kind: string; content: string; outcome?: string; replyTo?: string; unfinished?: string[] }): DeliveredMessage {
  if (!HOST_TOOL_KINDS.includes(input.kind as (typeof HOST_TOOL_KINDS)[number])) {
    throw new Error("kind 必须是 ack 或 finding。任务最终结果用 finding，不要发 reply。");
  }

  let text = assertDeliveryText(input.content);
  const requested = input.outcome ?? "complete";

  if (!["complete", "partial"].includes(requested)) throw new Error("outcome 必须是 complete 或 partial。");
  const runId = opts.getRunId();

  if (!runId) throw new Error("当前没有可绑定的任务，未交付。");
  const replyTo = input.replyTo?.trim() || undefined;

  if (replyTo !== undefined && replyTo.length > USER_DELIVERY_TEXT_MAX) throw new Error("reply_to 无效，请省略或给出完整引用，不要截断。");
  const next = input.kind === "finding" ? opts.getNextStep?.() ?? null : null;
  const rawFacts = input.kind === "finding" ? opts.getDeliveryFacts?.() ?? null : null;
  const settled = !next || next.delivery === "report";
  const open = rawFacts ? factsForDelivery(rawFacts, next) : null;
  const pageChanges = input.kind === "finding" ? opts.getPageChanges?.() ?? null : null;
  // 宿主事实：本轮试过改页面却一次都没生效。正文说做完了也不能记成完成。
  const pageUnchanged = !!pageChanges && pageChanges.attempts > 0 && pageChanges.changes === 0;
  const complete = requested === "complete" && settled && (!open || open.remaining.length + (open.omittedRemaining ?? 0) === 0) && !pageUnchanged;
  const hostFacts = rawFacts ? (complete ? open : rawFacts) : null;
  const projected = hostFacts ? projectDeliveryFacts(hostFacts, next, !complete) : undefined;
  const facts = projected && isUserDeliveryFacts(projected) ? projected : undefined;

  // 模型自己说了没做完：正文原样，部分完成记在 outcome/facts 上，由侧栏续做行说明。
  // 模型声称做完而宿主知道没做完：正文会误导用户（语音里也会被念出来），这时才补一句纠正。
  if (input.kind === "finding" && !complete && requested === "complete") {
    const awaiting = opts.getAwaitingConfirmation?.() ?? null;
    const note = awaiting ? awaitingConfirmationNote(awaiting) : pageUnchanged ? pageUnchangedNote(pageChanges!.attempts) : next ? partialResultNote(next) : "（这件事还没全部完成。）";

    text = clampDeliveryText(`${text}\n\n${note}`);
  }

  const deliveryInput: Parameters<typeof createUserDelivery>[0] = {
    id: input.id, conversationId: opts.conversationId, runId, kind: input.kind as UserDeliveryKind, text, replyTo, composedAt: (opts.clock ?? Date.now)(),
  };

  if (facts) deliveryInput.facts = facts;

  // 只有模型自己说没做完时才记它列的未完成项；声称完成却附带清单的，以宿主判定为准，不采信。
  if (input.kind === "finding" && requested === "partial") {
    const unfinished = cleanUnfinished(input.unfinished);

    if (unfinished.length) deliveryInput.unfinished = unfinished;
  }

  const delivery = createUserDelivery(deliveryInput);
  opts.emit({ kind: "user_delivery", delivery });

  return { delivery, outcome: complete ? "complete" : "partial" };
}

export function createSendUserMessageTool(opts: SendUserMessageOptions): ToolDefinition {
  return defineTool({
    name: "send_user_message",
    label: "Send a user-facing message",
    description:
      "Optional. Your final reply text already reaches the user. Use kind=ack for a start acknowledgement on a long task, or kind=finding to deliver a result before you continue working. outcome=partial marks unfinished or unconfirmed work; the host also marks the result partial when its ledger still has open items. Do not claim independent verification. Keep simple outcomes short. For substantial written results, lead with the finding and cite exact source URLs through descriptive Markdown links. Preserve any unread or unconfirmed limits.",
    parameters: Type.Object({
      kind: Type.Unsafe<"ack" | "finding">(Type.String({ description: "ack or finding." })),
      content: Type.String({ description: "Exact user-facing text. Do not truncate trailing limits." }),
      outcome: Type.Optional(Type.Union([Type.Literal('complete'),Type.Literal('partial')],{description:'For finding: partial reports limits without claiming unfinished work is done.'})),
      unfinished: Type.Optional(Type.Array(Type.String(), { description: "With outcome=partial: each part of the user's request you did not get done, phrased as the user asked it (e.g. 圈出「升级套餐」按钮). Not internal steps or tool names." })),
      reply_to: Type.Optional(Type.String({ description: "Optional user utterance or previous delivery id this answers" })),
    }),
    execute: async (_id, params) => {
      deliveryMetrics.toolCalls += 1;

      try {
        const { delivery, outcome } = deliverUserMessage(opts, { id: toolDeliveryId(_id), kind: params.kind, content: String(params.content ?? ""), outcome: params.outcome,
          replyTo: params.reply_to == null ? undefined : String(params.reply_to), unfinished: params.unfinished });

        const next = params.kind === "finding" ? opts.getNextStep?.() : undefined;

        return {
          content: [{ type: "text" as const, text: `delivered:${delivery.id}` }],
          details: next ? { id: delivery.id, outcome: delivery.facts?.outcome ?? outcome, nextAction: next.action, resultIds: next.resultIds } : { id: delivery.id },
          // finding 就是任务的最终结果：这一批工具结果带 terminate 后本轮结束，不再为收尾多问模型一次。
          // ack 只是开场应答，提前终止会掐断任务，因此不参与早停。
          // 浏览器调用仍在途（delivery=none）时话照常交付，但不结束本轮，模型还要看到那次调用的结果。
          terminate: params.kind === "finding" && (next ? next.delivery !== "none" : !opts.hasUnfinishedWork?.()),
        };
      } catch (error) {
        deliveryMetrics.toolRejected += 1;
        throw error;
      }
    },
  });
}

/** 附加的纠正说明不能把一条合法正文挤成超长而被丢弃；超出时截掉正文尾部并标明。 */
function clampDeliveryText(text: string): string {
  if (text.length <= USER_DELIVERY_TEXT_MAX) return text;

  return `${text.slice(0, USER_DELIVERY_TEXT_MAX - 12)}…（后文已截断）`;
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
