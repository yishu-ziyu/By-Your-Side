#!/usr/bin/env node
/**
 * Stagehand act/observe/extract + 真实 LLM 实测（实验，非生产接线）。
 *
 * 目的：花少量 LLM 调用，测出 act() 在本地表单上的成功率、每次耗时、token 用量。
 * 路径：isolated headless Chrome + 本地 fixture + ClientLLM（model.generate 回调）→
 *       本机 cli-proxy-api（OpenAI 兼容 /v1/chat/completions）。
 * 边界：不接日常 Chrome、不读用户 profile、不触碰生产代码；只写本目录 out/。
 *
 * 运行：node act-probe.mjs   （Node >=22.18）
 * 覆盖：PROBE_BASE_URL / PROBE_MODEL / PROBE_API_KEY 环境变量。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";

const DIR = path.dirname(fileURLToPath(import.meta.url));

const OUT_DIR = path.join(DIR, "out");

const BASE_URL = process.env.PROBE_BASE_URL ?? "http://127.0.0.1:8317/v1";

const MODEL = process.env.PROBE_MODEL ?? "deepseek-v4.1-flash";

const API_KEY = process.env.PROBE_API_KEY ?? "sk-probe";

const log = (line) => process.stdout.write(`${line}\n`);

/** LLM 账本：每次 generate 记时记 token，按 case 归集。 */
const llm = { calls: 0, inputTokens: 0, outputTokens: 0, caseCalls: [] };

function textOf(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) return content.map((block) => block?.text ?? "").join("");

  return "";
}

/** Stagehand 的 Anthropic 风格消息 → OpenAI chat 格式。 */
function toOpenAIMessages({ messages, systemPrompt }) {
  const out = [];

  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const message of messages ?? []) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];

    if (message.role === "assistant") {
      const toolCalls = [];
      let text = "";

      for (const block of blocks) {
        if (block?.type === "tool_use") {
          let args;

          try { args = JSON.stringify(block.input ?? {}); } catch { args = "{}"; }

          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: args },
          });
        } else if (block?.type === "text") text += block.text;
      }

      const entry = { role: "assistant", content: text || null };

      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }

    for (const block of blocks) {
      if (block?.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: block.toolUseId, content: textOf(block.content) });
      } else if (block?.type === "image") {
        out.push({
          role: message.role,
          content: [{ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }],
        });
      } else if (block?.type === "text") {
        out.push({ role: message.role, content: block.text });
      }
    }
  }

  return out;
}

/** ClientLLM.generate：Stagehand 每要一次模型就来这里，转发到本机代理。 */
async function generate(params) {
  const started = Date.now();

  const body = {
    model: MODEL,
    messages: toOpenAIMessages(params),
    temperature: params.temperature ?? 0,
  };

  if (params.tools?.length) {
    body.tools = params.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema },
    }));
    const mode = params.toolChoice?.mode;

    if (mode && mode !== "auto") body.tool_choice = mode;
  }

  const wantsJson =
    params.responseFormat?.type === "json_schema";

  if (wantsJson) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: params.responseFormat.name ?? "result",
        description: params.responseFormat.description,
        schema: params.responseFormat.schema,
        strict: true,
      },
    };
  }

  let response = await callProxy(body);

  if (response.status >= 400 && wantsJson) {
    // 部分代理/模型不支持 response_format：退回提示词内嵌 schema，重新要一次。
    delete body.response_format;
    body.messages.push({
      role: "system",
      content: `Respond with a single JSON value that validates this JSON Schema:\n${JSON.stringify(params.responseFormat.schema)}`,
    });
    response = await callProxy(body);
  }

  if (response.status >= 400) throw new Error(`LLM HTTP ${response.status}: ${response.data.slice(0, 300)}`);

  const data = response.json;
  const usage = data.usage ?? {};
  llm.calls += 1;
  llm.inputTokens += usage.prompt_tokens ?? 0;
  llm.outputTokens += usage.completion_tokens ?? 0;
  llm.caseCalls.push({ ms: Date.now() - started, tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) });

  const choice = data.choices?.[0]?.message ?? {};
  const raw = textOf(choice.content);

  // 注意：键存在但值为 undefined 会让上层 z.json() 整体校验失败，必须只在有值时才挂键。
  const base = { role: "assistant", usage: {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  } };

  if (choice.finish_reason) base.stopReason = choice.finish_reason;

  if (wantsJson) {
    const structuredContent = parseJsonLoose(raw);
    const result = { ...base, content: [{ type: "text", text: raw }], outputFormat: "json_schema", structuredContent };
    log(`[gen] json_schema -> ${JSON.stringify(result).slice(0, 500)}`);

    return result;
  }

  if (choice.tool_calls?.length) {
    return {
      ...base,
      content: choice.tool_calls.map((call) => {
        let input = {};

        try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }

        return { type: "tool_use", id: call.id, name: call.function.name, input };
      }),
      outputFormat: "text",
    };
  }

  const textResult = { ...base, content: raw, outputFormat: "text" };
  log(`[gen] text -> ${JSON.stringify(textResult).slice(0, 500)}`);

  return textResult;
}

async function callProxy(body) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  const data = await response.text();
  let json = null;

  try { json = JSON.parse(data); } catch { /* 保留在 text 里报错 */ }

  return { status: response.status, data, json };
}

function parseJsonLoose(raw) {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  try { return JSON.parse(stripped); } catch { /* 继续尝试截取 */ }

  const start = stripped.search(/[[{]/);

  if (start >= 0) {
    try { return JSON.parse(stripped.slice(start)); } catch { /* 归为失败 */ }
  }

  throw new Error(`model did not return JSON: ${stripped.slice(0, 200)}`);
}

async function serveFixture() {
  const html = await readFile(path.join(DIR, "fixture", "form.html"), "utf8");

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function state(page) {
  const raw = await page.locator("#probe-state").textContent();
  let parsed;

  try { parsed = JSON.parse(raw); } catch { throw new Error(`fixture 状态不可解析: ${String(raw).slice(0, 120)}`); }

  return { url: await page.url(), ...parsed };
}

const record = {
  task: "stagehand-act-llm-probe",
  sdk: "4.1.0",
  baseUrl: BASE_URL,
  model: MODEL,
  startedAt: new Date().toISOString(),
  cases: [],
};

/** 一个 case：计时 + 归集本 case 内的 LLM 调用，出错记 FAIL 不中断整体。 */
async function runCase(id, verify, action) {
  const callsBefore = llm.caseCalls.length;
  const started = Date.now();
  let status = "PASS";
  let detail = "";

  try {
    detail = (await verify(action())) ?? "ok";
  } catch (error) {
    status = "FAIL";
    detail = String(error?.message ?? error);

    if (error?.issues) detail += ` :: ${JSON.stringify(error.issues).slice(0, 8000)}`;
  }

  const ms = Date.now() - started;
  const caseCalls = llm.caseCalls.splice(callsBefore);
  record.cases.push({
    id, status, ms,
    llmCalls: caseCalls.length,
    tokens: caseCalls.reduce((sum, entry) => sum + entry.tokens, 0),
    detail,
  });
  log(`${status.padEnd(5)} ${id.padEnd(24)} ${String(ms).padStart(6)}ms  llm×${caseCalls.length}  ${detail.slice(0, 4000)}`);
}

async function main() {
  const fixture = await serveFixture();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "stagehand-act-"));
  let browser;
  let stagehand;

  try {
    browser = await localBrowser.launch({ headless: true, userDataDir });
    stagehand = await Stagehand.create({ browser, model: { generate } });
    const context = browser.context;
    const [first] = await context.pages();
    const page = first ?? (await context.newPage());
    await page.goto(fixture.url);

    await runCase("act.fill.firstName", async (pending) => {
      await pending;
      const s = await state(page);

      if (s.values.firstName !== "Ada") throw new Error(`firstName=${JSON.stringify(s.values.firstName)}`);

      return "firstName=Ada";
    }, () => stagehand.act("在 First name 输入框填写 Ada"));

    await runCase("act.fill.lastName", async (pending) => {
      await pending;
      const s = await state(page);

      if (s.values.lastName !== "Lovelace") throw new Error(`lastName=${JSON.stringify(s.values.lastName)}`);

      return "lastName=Lovelace";
    }, () => stagehand.act("在 Last name 输入框填写 Lovelace"));

    await runCase("act.fill.email", async (pending) => {
      await pending;
      const s = await state(page);

      if (s.values.email !== "ada@example.com") throw new Error(`email=${JSON.stringify(s.values.email)}`);

      return "email=ada@example.com";
    }, () => stagehand.act("把邮箱 ada@example.com 填进 Email 输入框"));

    await runCase("act.click.save", async (pending) => {
      await pending;
      const s = await state(page);

      if (s.submits < 1) throw new Error(`submits=${s.submits}`);

      return `submits=${s.submits} url仍在fixture=${s.url.startsWith("http://127.0.0.1:")}`;
    }, () => stagehand.act("点击 Save 按钮提交表单"));

    await runCase("observe.actionable", async (pending) => {
      const result = await pending;
      const count = Array.isArray(result) ? result.length : JSON.stringify(result).length;

      if (!count) throw new Error("observe 返回空");

      return `返回 ${Array.isArray(result) ? result.length + " 项" : count + " 字符"}`;
    }, () => stagehand.observe("这个页面上有哪些可以操作的元素？"));

    await runCase("extract.form.fields", async (pending) => {
      const result = await pending;
      const data = result?.data ?? result;
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const hasFields = ["First name", "Last name", "Email", "City"].every((label) => text.includes(label));

      if (!hasFields) throw new Error(`extract 缺字段: ${text.slice(0, 200)}`);

      return `包含全部 4 个字段标签 (${text.length} 字符)`;
    }, () => stagehand.extract("列出表单里的所有输入字段和它们的标签文字"));
  } catch (error) {
    record.fatal = String(error?.stack ?? error);
    log(`FATAL ${record.fatal.slice(0, 400)}`);
  } finally {
    try { await stagehand?.close?.(); } catch { /* 忽略 */ }

    try { await browser?.close?.(); } catch { /* 忽略 */ }

    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true }).catch(() => undefined);
  }

  record.finishedAt = new Date().toISOString();
  record.totals = {
    cases: record.cases.length,
    passed: record.cases.filter((entry) => entry.status === "PASS").length,
    llmCalls: llm.calls,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    totalWallMs: record.cases.reduce((sum, entry) => sum + entry.ms, 0),
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "act-probe-result.json"), `${JSON.stringify(record, null, 2)}\n`);
  const t = record.totals;
  log(`--- 成功 ${t.passed}/${t.cases} · LLM 调用 ${t.llmCalls} 次 · tokens ${t.inputTokens}+${t.outputTokens} · 纯操作合计 ${t.totalWallMs}ms`);
}

main().then(() => process.exit(0), (error) => {
  log(`FATAL ${String(error?.stack ?? error)}`);
  process.exit(1);
});
