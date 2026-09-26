/**
 * 本机脚本模型：OpenAI 兼容的 /chat/completions，按任务原话里的关键词回写好的正文或工具调用。
 *
 * 用在「界面怎么呈现」的验收：工具调用、宿主核验、账本和页面标注都是产品自己的逻辑在跑，只有模型回复是脚本。
 * 规则按最后一条匹配关键词的用户消息挑选；同一任务里已收到几条工具结果，就走到第几步。
 * 不匹配的请求（产品内部的判断、翻译等）回一句「好的。」。每次请求记下相对启动的毫秒数，供耗时判据使用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { siteAddress, type JsonRecord } from "./harness.mts";

type ToolCall = { name: string; args: JsonRecord };

/** 一步：写正文、调用一个工具、回错误码，或先挂起再回。 */
export type Step = { text: string; delayMs?: number } | { tool: ToolCall; delayMs?: number } | { status: number; body: string };

export type Rule = { match: string; steps: Step[] };

type ContentPart = { type?: string; text?: string };

/** OpenAI 兼容请求里的一条消息：content 是字符串或分段数组。 */
type ChatMessage = { role: string; content?: string | ContentPart[] | null };

export type ModelRequest = { atMs: number; rule: string | null; step: number; status: number };

const textOf = (content: ChatMessage["content"]): string => Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content ?? "";

function pick(rules: Rule[], messages: ChatMessage[]): { rule: Rule; step: number } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;

    if (message.role !== "user") continue;
    const text = textOf(message.content);
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

function stream(res: ServerResponse, step: { text: string } | { tool: ToolCall }, callId: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(chunk({ role: "assistant", content: "" }));

  if ("text" in step) {
    for (const piece of step.text.match(/[\s\S]{1,12}/g) ?? []) res.write(chunk({ content: piece }));
    res.write(chunk({}, "stop"));
  } else {
    res.write(chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }));
    res.write(chunk({}, "tool_calls"));
  }

  res.write(`data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model: "demo-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function json(res: ServerResponse, step: { text: string } | { tool: ToolCall }, callId: string): void {
  const message = "text" in step ? { role: "assistant", content: step.text }
    : { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] };

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

export async function startScriptedModel(rules: Rule[]) {
  const origin = Date.now();
  const requests: ModelRequest[] = [];
  let calls = 0;

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
    const payload = JSON.parse(await body(req)) as { messages?: ChatMessage[]; stream?: boolean };
    const messages = payload.messages ?? [];
    const found = pick(rules, messages);
    const step: Step = found ? found.rule.steps[found.step]! : { text: textOf(messages.at(-1)?.content).includes("Reply with the single word OK") ? "OK" : "好的。" };
    const atMs = Date.now() - origin;

    if ("status" in step) {
      requests.push({ atMs, rule: found?.rule.match ?? null, step: found?.step ?? 0, status: step.status });
      res.writeHead(step.status, { "content-type": "application/json" }).end(step.body);

      return;
    }

    requests.push({ atMs, rule: found?.rule.match ?? null, step: found?.step ?? 0, status: 200 });

    if (step.delayMs) await new Promise((done) => setTimeout(done, step.delayMs));
    const callId = `call_${++calls}`;

    if (payload.stream === false) json(res, step, callId);
    else stream(res, step, callId);
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  return {
    baseUrl: `http://127.0.0.1:${siteAddress(server).port}/v1`,
    requests,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
