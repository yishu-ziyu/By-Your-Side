/**
 * 本机脚本模型：OpenAI 兼容的 /chat/completions，按任务原话里的关键词回写好的正文或工具调用。
 *
 * 用在「界面怎么呈现」的验收：工具调用、宿主核验、账本和页面标注都是产品自己的逻辑在跑，只有模型回复是脚本。
 * 规则先按用户自己的消息挑：从后往前第一条匹配关键词的那条；同一任务里它之后已收到几条工具结果，就走到第几步。
 * 产品插进对话的上下文段（开头是 agent/src/pi-agent-loop.ts 和 agent/src/product-context.ts 写的两种「不是用户消息」）
 * 只在用户的消息一条都不匹配时才参与挑选。
 * 不匹配的请求（产品内部的判断、翻译等）回一句「好的。」；任务起名回「起名 N 站」。每次请求记下相对启动的毫秒数，供耗时判据使用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { siteAddress, type JsonRecord } from "./harness.mts";

type ToolCall = { name: string; args: JsonRecord };

/**
 * 一步：写正文、调用一个工具、回错误码，或先挂起再回。
 * 正文可设 chunkDelayMs（每段之间停顿，模拟慢模型逐段输出）和 thenTool（同一条回复里写完正文再调工具）；
 * reasoning 是正文前的思考摘要，按 OpenAI 兼容的 reasoning_content 分段送出。
 */
/** pieces：按给定的段和每段之前的停顿写出（替代 12 字一段的均匀切分），用来在标签写到一半时停一下。 */
export type TextStep = { text: string; delayMs?: number; chunkDelayMs?: number; thenTool?: ToolCall; reasoning?: string; pieces?: Array<{ text: string; delayMs?: number }>; usage?: StepUsage };

/** 这次回复报的用量：prompt 是整段提示词的 token，cached 是其中命中缓存的（OpenAI 兼容的 prompt_tokens_details.cached_tokens）。不写报 10。 */
export type StepUsage = { prompt: number; cached?: number };

/** tools：同一条回复里并行调用几个工具；每个工具结果都让后面的步数加一，所以它后面要按工具个数留占位步。 */
export type Step = TextStep | { tool: ToolCall; delayMs?: number; usage?: StepUsage } | { tools: ToolCall[]; delayMs?: number; usage?: StepUsage } | { status: number; body: string };

export type Rule = { match: string; steps: Step[] };

type ContentPart = { type?: string; text?: string };

/** OpenAI 兼容请求里的一条消息：content 是字符串或分段数组。 */
type ChatMessage = { role: string; content?: string | ContentPart[] | null };

/**
 * firstTextAt / lastTextAt：首段、末段正文写出时的本机时间（Date.now()），供「侧栏多久后出字」比对；tools：请求带工具表（主任务请求）。
 * closedAt：这次回复的连接关闭时的本机时间；finished：关闭时回复已经写完。没写完就关了，说明产品中途取消了这次请求。
 */
export type ModelRequest = { atMs: number; rule: string | null; step: number; status: number; firstTextAt?: number; lastTextAt?: number; tools?: boolean; closedAt?: number; finished?: boolean };

const textOf = (content: ChatMessage["content"]): string => Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content ?? "";

/**
 * 产品插进对话的数据段，开头自己写明「不是用户消息」。本次运行的上下文里有往期任务和对话的原话：
 * 它和用户这一轮的话都匹配时，用户的话优先；只有用户的话一条都不匹配，才看数据段。
 */
export const PRODUCT_DATA = ["本次运行的上下文，不是用户消息", "应用状态快照，不是新用户消息"];

function pick(rules: Rule[], messages: ChatMessage[]): { rule: Rule; step: number } | null {
  return pickFrom(rules, messages, (text) => !PRODUCT_DATA.some((head) => text.startsWith(head))) ?? pickFrom(rules, messages, () => true);
}

function pickFrom(rules: Rule[], messages: ChatMessage[], eligible: (text: string) => boolean): { rule: Rule; step: number } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;

    if (message.role !== "user") continue;
    const text = textOf(message.content);

    if (!eligible(text)) continue;
    const rule = rules.find((r) => text.includes(r.match));

    if (!rule) continue;
    const toolResults = messages.slice(i + 1).filter((m) => m.role === "tool").length;

    return { rule, step: Math.min(toolResults, rule.steps.length - 1) };
  }

  return null;
}

const chunk = (delta: JsonRecord, finish: string | null = null) => `data: ${JSON.stringify({
  id: "chatcmpl-scripted", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "demo-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;

const toolCalls = (step: { tool: ToolCall } | { tools: ToolCall[] }, callId: string) => ("tools" in step ? step.tools : [step.tool])
  .map((tool, index) => ({ index, id: index ? `${callId}_${index}` : callId, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }));

async function stream(res: ServerResponse, step: (TextStep | { tool: ToolCall } | { tools: ToolCall[] }) & { usage?: StepUsage }, callId: string, record?: ModelRequest): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "" }));

  if ("text" in step) {
    for (const piece of step.reasoning?.match(/[\s\S]{1,12}/g) ?? []) res.write(chunk({ reasoning_content: piece }));

    for (const [i, piece] of (step.pieces?.map((p) => p.text) ?? step.text.match(/[\s\S]{1,12}/g) ?? []).entries()) {
      const pause = step.pieces ? step.pieces[i]!.delayMs : record?.firstTextAt !== undefined ? step.chunkDelayMs : undefined;

      if (pause) await new Promise((done) => setTimeout(done, pause));
      res.write(chunk({ content: piece }));

      if (record) { record.firstTextAt ??= Date.now(); record.lastTextAt = Date.now(); }
    }

    if (step.thenTool) {
      res.write(chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: step.thenTool.name, arguments: JSON.stringify(step.thenTool.args) } }] }));
      res.write(chunk({}, "tool_calls"));
    } else res.write(chunk({}, "stop"));
  } else {
    res.write(chunk({ tool_calls: toolCalls(step, callId) }));
    res.write(chunk({}, "tool_calls"));
  }

  const prompt = step.usage?.prompt ?? 10;
  const usage = { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10, ...(step.usage?.cached ? { prompt_tokens_details: { cached_tokens: step.usage.cached } } : {}) };
  res.write(`data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: "demo-model", choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function json(res: ServerResponse, step: TextStep | { tool: ToolCall } | { tools: ToolCall[] }, callId: string): void {
  const message = "text" in step ? { role: "assistant", content: step.text }
    : { role: "assistant", content: null, tool_calls: toolCalls(step, callId).map(({ index: _index, ...call }) => call) };

  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "chatcmpl-scripted", object: "chat.completion", created: 0, model: "demo-model",
    choices: [{ index: 0, message, finish_reason: "text" in step ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
}

async function body(req: IncomingMessage): Promise<string> {
  let text = "";

  for await (const part of req) text += part;

  return text;
}

/**
 * 整页翻译请求（产品的翻译提示词）：逐段回「中文译文：<原文>」。
 * maxConcurrent 模仿服务商的并发上限（Kimi 编程套餐超限时回 403 concurrent request limit）。
 */
export type TranslateOptions = { maxConcurrent?: number; delayMs?: number; /** 接下来这么多个翻译请求回 500（普通故障，不是限流）。 */ failNext?: number };

const THROTTLE_BODY = JSON.stringify({ error: { type: "permission_error", message: "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again." }, type: "error" });

/** OpenAI 兼容服务超窗口时的回复；pi-ai 按 "maximum context length is N tokens" 认出超窗口。 */
const OVERFLOW_BODY = JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } });

/** overflow：主任务请求的原文让它返回 true 时，回超窗口错误（模拟上下文窗口满了）。 */
export async function startScriptedModel(rules: Rule[], translate?: TranslateOptions, inspect?: (payload: { messages?: ChatMessage[]; stream?: boolean; tools?: unknown[] }) => void, overflow?: (raw: string) => boolean) {
  const origin = Date.now();
  const requests: ModelRequest[] = [];
  let calls = 0;
  let translating = 0;

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "demo-model", object: "model" }] }));

      return;
    }

    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.writeHead(404).end();

      return;
    }

    // SAFETY: OpenAI 兼容请求体，messages 为消息数组。
    const raw = await body(req);
    const payload = JSON.parse(raw) as { messages?: ChatMessage[]; stream?: boolean; tools?: unknown[] };
    const messages = payload.messages ?? [];
    inspect?.(payload);

    if (overflow && payload.tools?.length && overflow(raw)) {
      requests.push({ atMs: Date.now() - origin, rule: "overflow", step: 0, status: 400, tools: true });
      res.writeHead(400, { "content-type": "application/json" }).end(OVERFLOW_BODY);

      return;
    }

    if (translate && messages.some((m) => m.role === "system" && textOf(m.content).startsWith("Translate the supplied webpage text"))) {
      const atMs = Date.now() - origin;

      if (translating >= (translate.maxConcurrent ?? Infinity)) {
        requests.push({ atMs, rule: "translate", step: 0, status: 403 });
        res.writeHead(403, { "content-type": "application/json" }).end(THROTTLE_BODY);

        return;
      }

      if (translate.failNext) {
        translate.failNext -= 1;
        requests.push({ atMs, rule: "translate", step: 0, status: 500 });
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "scripted upstream failure" } }));

        return;
      }

      translating += 1;
      requests.push({ atMs, rule: "translate", step: 0, status: 200 });

      try {
        await new Promise((done) => setTimeout(done, translate.delayMs ?? 800));
        // SAFETY: 产品的翻译请求体是 {language, blocks:[{id, segments:[{id, text}]}]}。
        const input = JSON.parse(textOf(messages.find((m) => m.role === "user")?.content)) as { blocks: Array<{ segments: Array<{ id: string; text: string }> }> };
        const out = input.blocks.flatMap((b) => b.segments.map((seg) => ({ id: seg.id, text: `中文译文：${seg.text}` })));
        const step = { text: JSON.stringify(out) };

        if (payload.stream === false) json(res, step, `call_${++calls}`);
        else await stream(res, step, `call_${++calls}`);
      } finally {
        translating -= 1;
      }

      return;
    }

    // 任务起名（agent/src/session.ts nameTask）：按碰过几个网站回名字，用例据此看标签组名跟着网站变；不计入 requests，不打乱各用例按规则数请求。
    if (messages.some((m) => m.role === "system" && textOf(m.content).startsWith("Name a browser task"))) {
      // SAFETY: 产品的起名请求体是 {task, pages:[{site, title}]}。
      const input = JSON.parse(textOf(messages.find((m) => m.role === "user")?.content)) as { pages: Array<{ site: string }> };
      const step = { text: JSON.stringify({ title: `起名 ${new Set(input.pages.map((p) => p.site)).size} 站` }) };

      if (payload.stream === false) json(res, step, `call_${++calls}`);
      else await stream(res, step, `call_${++calls}`);

      return;
    }

    const found = pick(rules, messages);
    const picked: Step = found ? found.rule.steps[found.step]! : { text: textOf(messages.at(-1)?.content).includes("Reply with the single word OK") ? "OK" : "好的。" };
    const step = withRecheck(picked, textOf(messages.at(-1)?.content));
    const atMs = Date.now() - origin;

    if ("status" in step) {
      requests.push({ atMs, rule: found?.rule.match ?? null, step: found?.step ?? 0, status: step.status });
      res.writeHead(step.status, { "content-type": "application/json" }).end(step.body);

      return;
    }

    const record: ModelRequest = { atMs, rule: found?.rule.match ?? null, step: found?.step ?? 0, status: 200, tools: !!payload.tools?.length };
    requests.push(record);
    res.on("close", () => { record.closedAt = Date.now(); record.finished = res.writableFinished; });

    if (step.delayMs) await new Promise((done) => setTimeout(done, step.delayMs));
    const callId = `call_${++calls}`;

    if (payload.stream === false) json(res, step, callId);
    else await stream(res, step, callId, record);
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  return {
    baseUrl: `http://127.0.0.1:${siteAddress(server).port}/v1`,
    requests,
    translate,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const RECHECK_MARK = "\nRECHECK:";

/** 转发复核请求时，在脚本结论后面接上 RECHECK 和要补的字段：照首轮结论判继续时，把这些字段并进结论。 */
export const recheckProbe = (probe: string, fields: { verificationSubject: string; evidence: string }) => `${probe}${RECHECK_MARK}${JSON.stringify(fields)}`;

function withRecheck(step: Step, lastUser: string): Step {
  const at = lastUser.indexOf(RECHECK_MARK);
  if (at < 0 || !("text" in step) || typeof step.text !== "string") return step;
  try {
    // SAFETY: 首轮结论是用例自己写的 JSON；补的字段由 recheckProbe 生成。
    const verdict = JSON.parse(step.text) as { status?: string };
    if (verdict.status !== "continue") return step;
    return { ...step, text: JSON.stringify({ ...verdict, ...(JSON.parse(lastUser.slice(at + RECHECK_MARK.length)) as object) }) };
  } catch { return step; }
}

/**
 * 目标核对的复核请求（输入里带 verification）：产品只在复核仍判继续、核对对象没变、且 evidence 能在复核读数（或回答）里原样找到时才接着做。
 * 返回复核时继续要带上的字段；不是复核请求时返回 null。
 */
export function reverifyContinue(body: string): { verificationSubject: string; evidence: string } | null {
  // SAFETY: 产品发出的 OpenAI 兼容请求体；核对输入是 user 消息里的一段 JSON。
  const request = JSON.parse(body) as { messages?: ChatMessage[] };
  const user = (request.messages ?? []).find((m) => m.role === "user");
  let input: { lastReply?: string; verification?: { finding?: { verificationSubject?: string }; reads?: Array<{ data?: string }> } };
  try { input = JSON.parse(textOf(user?.content)) as typeof input; } catch { return null; }
  if (!input.verification) return null;
  const verificationSubject = input.verification.finding?.verificationSubject ?? "page";
  const source = verificationSubject === "answer" ? input.lastReply ?? "" : (input.verification.reads ?? []).map((read) => read.data ?? "").find((data) => data.trim()) ?? "";
  const evidence = source.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !/^[a-z_]+:$/i.test(line))?.slice(0, 60) ?? "";
  return { verificationSubject, evidence };
}
