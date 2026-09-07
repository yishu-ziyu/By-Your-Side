import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunTrace, sanitizeTrace } from "../src/run-trace.js";

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), "sideagent-trace-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("RunTrace", () => {
  it("records program child steps under the parent and hides source code and input literals", async () => {
    const trace = new RunTrace(await directory());
    trace.begin("edit a test draft", {}, "provider/model");
    trace.event({ type: "tool_execution_start", toolName: "browser_run", toolCallId: "parent", args: { code: 'await browser.fill({target:"@9",value:"private-value"})' } });
    trace.event({ type: "tool_execution_update", toolName: "browser_run", toolCallId: "parent", partialResult: { details: { programStep: {
      parentId: "parent", id: "parent/1", name: "fill", phase: "start", params: { target: "@9", value: "private-value" },
    } } } });
    trace.event({ type: "tool_execution_update", toolName: "browser_run", toolCallId: "parent", partialResult: { details: { programStep: {
      parentId: "parent", id: "parent/1", name: "fill", phase: "end", result: { filled: true }, elapsedMs: 12,
    } } } });
    await trace.flush();
    const text = await readFile(trace.path, "utf8");
    expect(text).not.toContain("private-value");
    const steps = text.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "program_step");
    expect(steps).toHaveLength(2);
    expect(steps[1].data).toMatchObject({ parentToolCallId: "parent", step: { id: "parent/1", result: { filled: true }, elapsedMs: 12 } });
  });
  it("links goal, turns, real tool output, errors, and handback without logging deltas", async () => {
    const trace = new RunTrace(await directory());
    trace.begin("open editor", { tabId: 2, url: "https://example.com" }, "provider/model");
    trace.event({ type: "turn_start" });
    trace.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "do not log delta" } });
    trace.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } });
    trace.event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "js", args: { code: "document.title" } });
    trace.event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "js", isError: false, result: { content: [{ type: "text", text: "Editor entry exists" }] } });
    trace.event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "click", args: { target: "@42" } });
    trace.event({ type: "tool_execution_end", toolCallId: "call-2", toolName: "click", isError: true, result: { content: [{ type: "text", text: "Extension disconnected" }] } });
    trace.record("takeover"); trace.record("handback", { snapshot: "editor open" });
    trace.event({ type: "agent_end", messages: [], willRetry: false });
    await trace.flush();
    const text = await readFile(trace.path, "utf8");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(new Set(rows.map((row) => row.sessionId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.runId)).size).toBe(1);
    expect(rows.filter((row) => row.type === "first_response")).toHaveLength(1);
    expect(text).not.toContain("do not log delta");
    expect(rows.find((row) => row.type === "tool_execution_end").data).toMatchObject({ toolCallId: "call-1", isError: false, elapsedMs: expect.any(Number) });
    expect(text).toContain("Editor entry exists");
    expect(text).toContain("Extension disconnected");
    expect((await stat(trace.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(trace.path, ".."))).mode & 0o777).toBe(0o700);
  });

  it("redacts secrets in structured args, sensitive fill targets, free text, URL and images", () => {
    const result = JSON.stringify(sanitizeTrace({
      password: "one", args: { target: 'input[type="password"]', text: "two" },
      text: 'password="three four" Bearer five api_key=six https://user:seven@example.com?token=eight',
      content: [{ type: "image", data: "abcdef", mimeType: "image/png" }],
      attachment: { dataBase64: "ghijkl", mimeType: "image/png" },
      details: { imageBase64: "screenshot-payload", mediaType: "image/png" },
      message: { content: [{ type: "toolCall", args: { target: "#password", text: "nested-secret" } }] },
    }));
    for (const secret of ["one", "two", "three", "five", "six", "seven", "eight", "abcdef", "ghijkl", "screenshot-payload", "nested-secret"]) expect(result).not.toContain(secret);
    expect(result).toContain('"base64Chars":6');
  });

  it("marks truncated text and caps session files explicitly", async () => {
    expect(sanitizeTrace("a".repeat(65_000))).toMatchObject({ truncated: true, originalChars: 65_000 });
    expect(sanitizeTrace(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`key${i}`, i])))).toMatchObject({ traceTruncation: { truncated: true } });
    const trace = new RunTrace(await directory(), 500);
    trace.begin("goal", undefined, "model");
    trace.record("result", { text: "a".repeat(1000) });
    trace.record("ignored", { text: "later" });
    await trace.flush();
    const text = await readFile(trace.path, "utf8");
    expect(text).toContain('"type":"trace_limit"');
    expect(text).not.toContain("ignored");
  });

  it("write failures neither throw nor reject and retained file count is bounded", async () => {
    const dir = await directory();
    const bad = join(dir, "not-a-directory"); await writeFile(bad, "x");
    const trace = new RunTrace(bad);
    expect(() => trace.begin("goal", undefined, "model")).not.toThrow();
    await expect(trace.flush()).resolves.toBeUndefined();
    for (let i = 0; i < 22; i++) await writeFile(join(dir, `${1000 + i}-aaaaaaaa.jsonl`), "old");
    const good = new RunTrace(dir); good.begin("goal", undefined, "model"); await good.flush();
    expect((await readdir(dir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(20);
  });

  it("never records typed input even when a ref or point hides the target type", () => {
    const events = [
      { toolName: "fill", args: { target: "@42", value: "fill-secret" } },
      { toolName: "type_text", args: { text: "typing-secret" } },
      { message: { content: [{ type: "toolCall", name: "fill", arguments: { target: "point:10,20", value: "assistant-secret" } }] } },
    ];
    const text = JSON.stringify(sanitizeTrace(events));
    for (const secret of ["fill-secret", "typing-secret", "assistant-secret"]) expect(text).not.toContain(secret);
    expect(text).toContain("@42");
    expect(text).toContain("[redacted]");
  });

  it("bounds wide payloads with one shared text/node budget before serialization", () => {
    const wide = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key${i}`, "x".repeat(64_000)]));
    const text = JSON.stringify(sanitizeTrace(wide));
    expect(text.length).toBeLessThan(100_000);
    expect(text).toContain('"truncated":true');
    const nodes = JSON.stringify(sanitizeTrace(Array.from({ length: 256 }, () => Array.from({ length: 256 }, () => ({ a: 1 })))));
    expect(nodes.length).toBeLessThan(30_000);
    expect(nodes).toContain('"truncated":true');
  });

  it("keeps screenshot geometry/identity metadata while omitting base64", () => {
    const out = JSON.stringify(sanitizeTrace({
      result: {
        imageBase64: "BIGPAYLOAD", mediaType: "image/png",
        width: 2560, height: 1600, pixelWidth: 2560, pixelHeight: 1600,
        cssWidth: 1440, cssHeight: 900, devicePixelRatio: 2,
        tabId: 11, url: "https://user:s3cret@example.com/page", title: "Work",
        source: "visible-tab", capturedAt: 123,
      },
    }));
    expect(out).not.toContain("BIGPAYLOAD");
    expect(out).toContain('"base64Chars":10');
    for (const fragment of ['"width":2560', '"cssWidth":1440', '"cssHeight":900', '"devicePixelRatio":2', '"tabId":11', '"source":"visible-tab"', '"capturedAt":123']) {
      expect(out).toContain(fragment);
    }
    // URL 进白名单但仍走字符串脱敏：凭据不落盘
    expect(out).not.toContain("s3cret");
    expect(out).toContain("example.com");
  });
});
