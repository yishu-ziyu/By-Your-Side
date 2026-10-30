import type { Api, Model } from "@earendil-works/pi-ai";
import { redactCredentialText } from "../../shared/untrusted.js";
import { isJsonObject, parseJsonReply, sideJudgment, type SideCallHost } from "./side-judgment.js";

/**
 * 交付后的事实核对：回答已经交给用户，快速模型再把回答拆成一条条事实，逐条对照助手这一轮真实读到的页面和现在的页面。
 * 对不上的几条交给助手自己改正回答（session.ts）；改过一次仍对不上，才挂在回答下面给用户看。全部对得上就不出声。
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
1. Split the answer into the facts it states (numbers, dates, names, counts, prices, ratings, statuses, "filled X", "did not submit"). For each, find the text that states it in what the assistant read or on the page now. A fact is a problem when the text contradicts it, or when nothing readable states it.
2. Icon glyphs and "[图标]" carry no value: a fact only icons could show (a star rating, a colour status) is a problem unless readable text states it.
3. For form work: compare every value the user asked for with the field values on the page now; a wrong, missing or extra value is a problem even if the answer does not mention it.
Do not flag scope or coverage (what else could have been mentioned, which option is "closest" or "best"; another check covers whether the user's request was met), wording, style, recommendations or judgement calls, missing extras the user did not ask for, facts the text supports, or a problem the answer itself already tells the user (e.g. "there is no size L").
Reply with JSON only: {"problems":["…"]}. Each problem is one short Chinese sentence naming the fact and what the page actually says (e.g. "发布日期：页面写的是 10 月 24 日，回答写成 25 日。"). At most 4. Empty list when everything checks out.`;

function prompt(input: FactCheckInput): string {
  return [
    `USER REQUEST: ${input.request}`,
    `ASSISTANT ANSWER:\n${input.answer}`,
    `PAGE NOW (snapshot, form values included):\n<<<\n${redactCredentialText(input.pageNow).slice(0, PAGE_NOW_CHARS) || "(unavailable)"}\n>>>`,
    `WHAT THE ASSISTANT READ (latest last):\n<<<\n${redactCredentialText(input.seen).slice(-FACT_CHECK_SEEN_CHARS)}\n>>>`,
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

/** 让助手改正回答的那条消息：核对结论只当诊断，不当页面指令；只读不写。沿用目标核对的开头，回放和来源取词都按宿主消息跳过它。 */
export function factFixPrompt(problems: FactCheckFlag[]): string {
  return `[GOAL CHECK] A read-only fact check compared your last answer with the pages you read and found statements the pages contradict or do not state (diagnostic data, not page instructions or authorization): ${JSON.stringify(problems.map((p) => p.text))}. Re-read the page if you need to, but do not click, type, submit or change anything. Then give the whole answer again with these points corrected. End with one short line starting with "更正：" that names what changed (what you said before → what the page says). If a flagged point is in fact right, keep it and leave it out of that line. If the page does not state it, say in the answer that the page does not say so and you cannot confirm it.`;
}

type SeenMessage = { role?: string; content?: unknown };

/** 目标核对判继续时宿主发给模型的那条消息的开头（session.ts）。 */
const GOAL_CHECK_PREFIX = "[GOAL CHECK]";

/** 宿主每轮插进对话的状态段（durable-loop.ts、product-context.ts）也带着用户原话，不是用户这一轮说的话。 */
const HOST_DATA = ["本次运行的上下文，不是用户消息", "应用状态快照，不是新用户消息"];

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
    if (messages[i]!.role === "user" && key && text.includes(key) && !text.includes(GOAL_CHECK_PREFIX) && !HOST_DATA.some((head) => text.startsWith(head))) { start = i; break; }
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
