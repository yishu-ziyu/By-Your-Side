import type { Api, Model } from "@earendil-works/pi-ai";
import { isJsonObject, parseJsonReply, sideJudgment, type SideCallHost } from "./side-judgment.js";

/**
 * 交付后的事实核对：回答已经交给用户，快速模型再把回答拆成一条条事实，逐条对照助手这一轮真实读到的页面和现在的页面。
 * 只把对不上、找不到、答非所问、表单值不符的几条交给侧栏；全部对得上就不出声。
 * 为什么另起一步、不并进目标核对：目标核对判「做完没有」并驱动续做，这里只给用户看，判错也不改变助手接下来做什么。
 */

export interface FactCheckInput {
  /** 用户这一轮的原话。 */
  request: string;
  /** 交给用户的回答（不含出处标签）。 */
  answer: string;
  /** 这一轮助手读到的页面内容：读页、工具结果、交付前附带的页面。只用来对照，不发回界面。 */
  seen: string;
  /** 交付后当前标签页的快照（表单值在这里）。 */
  pageNow: string;
}

export interface FactCheckFlag { text: string }

/** 对照材料的上限：只取最后这么多字（最近读到的最接近交付时的页面）。 */
export const FACT_CHECK_SEEN_CHARS = 60_000;
const PAGE_NOW_CHARS = 12_000;

const SYSTEM = `You check a browser assistant's final answer after it reached the user. The user cannot see the pages; you can see what the assistant read and the page as it is now.
1. Does the answer address exactly what the user asked (same paper, product, version, scope, time range, superlative)? If not, that is a problem.
2. Split the answer into the facts it states (numbers, dates, names, counts, prices, ratings, statuses, "filled X", "did not submit"). For each, find the text that states it in what the assistant read or on the page now. A fact is a problem when the text contradicts it, or when nothing readable states it.
3. Icon glyphs and "[图标]" carry no value: a fact only icons could show (a star rating, a colour status) is a problem unless readable text states it.
4. For form work: compare every value the user asked for with the field values on the page now; a wrong, missing or extra value is a problem even if the answer does not mention it.
Do not flag wording, style, recommendations or judgement calls, missing extras the user did not ask for, facts the text supports, or a problem the answer itself already tells the user (e.g. "there is no size L").
Reply with JSON only: {"problems":["…"]}. Each problem is one short Chinese sentence telling the user what to check and what the page actually says (e.g. "请核对发布日期：页面写的是 10 月 24 日，回答写成 25 日。"). At most 4. Empty list when everything checks out.`;

function prompt(input: FactCheckInput): string {
  return [
    `USER REQUEST: ${input.request}`,
    `ASSISTANT ANSWER:\n${input.answer}`,
    `PAGE NOW (snapshot, form values included):\n<<<\n${input.pageNow.slice(0, PAGE_NOW_CHARS) || "(unavailable)"}\n>>>`,
    `WHAT THE ASSISTANT READ (latest last):\n<<<\n${input.seen.slice(-FACT_CHECK_SEEN_CHARS)}\n>>>`,
  ].join("\n\n");
}

const isReply = (value: unknown): value is { problems: string[] } =>
  isJsonObject(value) && Array.isArray((value as { problems?: unknown }).problems) && (value as { problems: unknown[] }).problems.every((p) => typeof p === "string");

/** 回答里有没有值得核对的事实：数字、日期，或这一轮读过页面。纯闲聊、只问用户的回答不核对。 */
export function worthChecking(input: Pick<FactCheckInput, "answer" | "seen">): boolean {
  return input.answer.trim().length >= 8 && input.seen.trim().length > 0;
}

export async function checkFacts(host: SideCallHost, model: Model<Api>, input: FactCheckInput, signal: AbortSignal, headers?: Record<string, string>): Promise<FactCheckFlag[]> {
  const reply = await sideJudgment(host, model, {
    purpose: "fact_check",
    systemPrompt: SYSTEM,
    content: prompt(input),
    maxTokens: 1_200,
    effort: "medium",
    timeoutMs: 90_000,
    signal,
    headers,
    retry: "format",
    parse: (text) => parseJsonReply(text, isReply),
  });

  return reply.problems.map((text) => text.trim()).filter(Boolean).slice(0, 4).map((text) => ({ text }));
}

type SeenMessage = { role?: string; content?: unknown };

/** 目标核对判继续时宿主发给模型的那条消息的开头（session.ts）。 */
const GOAL_CHECK_PREFIX = "[GOAL CHECK]";

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").join("") : "";

/**
 * 这一轮助手读到的页面：从用户这一轮的话开始往后的工具结果，和带 page-content 的页面观察。
 * roles 进诊断记录：核对材料不对时能看出是哪一类消息没取到。
 */
export function seenThisRun(messages: readonly SeenMessage[], request: string): { text: string; roles: Record<string, number> } {
  const key = request.trim().slice(0, 40);
  let start = 0;
  // 目标核对判继续时补发的提示也引用用户原话；从用户自己说这句话的地方算起，续做各轮读到的页面都要算进来。
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOf(messages[i]!.content);
    if (messages[i]!.role === "user" && key && text.includes(key) && !text.includes(GOAL_CHECK_PREFIX)) { start = i; break; }
  }
  const roles: Record<string, number> = {};
  const parts = messages.slice(start).flatMap((message) => {
    const role = message.role ?? "?", text = textOf(message.content);
    roles[role] = (roles[role] ?? 0) + 1;
    if (role === "toolResult") return [text];
    return text.includes("<page-content") ? [text] : [];
  });

  return { text: parts.join("\n\n----\n\n"), roles };
}
