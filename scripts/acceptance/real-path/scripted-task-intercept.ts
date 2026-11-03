import type { launchRealPath } from "./harness.mts";

type Browser = Awaited<ReturnType<typeof launchRealPath>>;
type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; content?: unknown };
type Message = { role?: string; content?: string | Block[] };

/** Only requests carrying the browser's tools are eligible for scripted task execution. */
export function isBrowserTaskRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const tools = (body as { tools?: Array<{ name?: string }> }).tools;
  return Array.isArray(tools) && tools.some(tool => tool.name === "mark");
}

function taskMessages(messages: Message[]): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role ?? "user", content: message.content });
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.filter(block => block.type === "text").map(block => block.text ?? "").join("");
    if (text) result.push({ role: message.role ?? "user", content: text });
    for (const block of blocks) {
      if (block.type === "tool_result") result.push({ role: "tool", content: "" });
    }
  }
  return result;
}

function anthropicStream(model: string, message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }): string {
  const events: string[] = [];
  const event = (value: { type: string } & Record<string, unknown>) => events.push(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: "message_start", message: { id: "msg_scripted_task", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = 0;
  if (message.content) {
    event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index, delta: { type: "text_delta", text: message.content } });
    event({ type: "content_block_stop", index: index++ });
  }
  for (const call of message.tool_calls ?? []) {
    event({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.function.name, input: {} } });
    event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
    event({ type: "content_block_stop", index: index++ });
  }
  event({ type: "message_delta", delta: { stop_reason: message.tool_calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
  event({ type: "message_stop" });
  return events.join("");
}

export async function interceptBrowserTask(
  rp: Browser, session: string, requestId: string, postData: string | undefined, scriptedBaseUrl: string,
  counts: { scripted: number; forwarded: number; failed: number },
): Promise<void> {
  try {
    const payload = JSON.parse(postData ?? "{}") as { model?: string; messages?: Message[]; tools?: unknown[] };
    if (!isBrowserTaskRequest(payload)) {
      counts.forwarded++;
      await rp.cdp.send("Fetch.continueRequest", { requestId }, session);
      return;
    }
    counts.scripted++;
    const response = await fetch(`${scriptedBaseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: taskMessages(payload.messages ?? []), tools: payload.tools, stream: false }),
    });
    if (!response.ok) throw new Error(`脚本任务模型返回 ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("脚本任务模型未返回消息");
    const body = Buffer.from(anthropicStream(payload.model ?? "", message)).toString("base64");
    await rp.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/event-stream" }], body }, session);
  } catch {
    counts.failed++;
    await rp.cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" }, session).catch(() => {});
  }
}
