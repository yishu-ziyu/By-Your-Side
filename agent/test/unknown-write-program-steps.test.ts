// 页面脚本结果未知时，browser_run 里的取数与存文件照常，只停改页面的步骤（docs/evals/20261001-data-to-file.md 标准 1–2）。
// 来源：2026-10-01 GLM-5.3-flash 实测「提取字幕并保存」——browser.js 一步报错留下未知结果后，
// 下一个只做 browser.fetch(GET) + browser.saveFile 的程序被整段拒绝，文件没存成。
// 先列失败方式，每条对应下面一个断言：
// 1. 未知结果在场时，读页 + GET 取数 + saveFile 的程序被拒，文件没存、取数请求没发出；
// 2. 反向过宽：改页面的步骤（click）在程序里也放行了，RPC 发了出去；
// 3. 反向过宽：带 body 的 POST 取数绕过暂停，或先去占用户确认；
// 4. 结果未知的那类页面脚本被自动重做（js RPC 又发了出去）；
// 5. artifacts 文件工具被一并挡住；
// 6. 放行之后未知结果被悄悄抹掉（账本里不再是 unknown），等于跳过核查；
// 7. 编译不过、一行没跑的页面脚本（扩展回 not_executed）仍留下未知结果，锁住后续步骤；
// 8. 宿主自带的只读探测（waitForLoad 读 readyState）被当成重做页面脚本挡住；
// 9. 反向过宽：夹带模型代码的探测（scrollToBottomUntil 的 condition）也被放行。
// 走生产装配（createConversationRuntime + 真实 TaskProgress 账本），扩展一侧用假回执代替；只看对外结果。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../../shared/protocol.js";
import { TaskProgress } from "../src/task-progress.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "./fixtures/file-document.js";
import { PROBE_PATTERN, scriptedModels } from "./fixtures/scripted-loop.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;

type Frame = Extract<ServerMessage, { type: "tool_call" }>;

const page = { tabId: 7, title: "字幕练习站", url: "http://video.test/video/BV1" };

const SUBTITLE = '{"body":[{"from":1.5,"to":3.6,"content":"第一句"},{"from":4.4,"to":5.6,"content":"第二句"}]}';

function textOf(result: Result): string {
  const first = result.content[0];

  if (first?.type !== "text") throw new Error("工具结果不是文本");

  return first.text;
}

async function lead() {
  const { createConversationRuntime } = await import("../src/conversation-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "bys-unknown-steps-"));
  dirs.push(dir);
  const progress = new TaskProgress("default");
  const frames: Frame[] = [];
  const messages: ServerMessage[] = [];
  // 扩展一侧的假回执，页面脚本分三种：编译不过（未运行）、宿主读文档状态的探测、其余运行中报错且结果未知。
  let reply: ((frame: Frame) => void) | undefined;

  const runtime = await createConversationRuntime("default", msg => {
    messages.push(msg);

    if (msg.type === "tool_call") {
      frames.push(msg);
      queueMicrotask(() => reply?.(msg));
    } else progress.observe(msg);
  }, PROBE_PATTERN, { loop: { models: scriptedModels(), cwd: "/tmp" }, memoryStore: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)) });

  reply = frame => {
    if (frame.name === "js" && frame.params.code === "return 1") runtime.rpc.handleResult(frame.id, false, undefined, "SyntaxError: Illegal return statement（脚本未运行，页面没有变化）", "not_executed");
    else if (frame.name === "js" && String(frame.params.code).startsWith("({readyState:document.readyState")) runtime.rpc.handleResult(frame.id, true, { value: { readyState: "complete", href: page.url, timeOrigin: 1 } }, undefined, "executed");
    else if (frame.name === "js") runtime.rpc.handleResult(frame.id, false, undefined, "SyntaxError: Expected property name or '}' in JSON at position 1", "unknown");
    else if (frame.name === "fetch") runtime.rpc.handleResult(frame.id, true, { url: String(frame.params.url), status: 200, ok: true, contentType: "application/json", bytes: SUBTITLE.length, truncated: false, text: SUBTITLE }, undefined, "executed");
    else if (frame.name === "snapshot") runtime.rpc.handleResult(frame.id, true, { text: "button \"字幕\"", tabId: 7, url: page.url }, undefined, "executed");
    else runtime.rpc.handleResult(frame.id, true, {}, undefined, "executed");
  };

  runtime.session.bindConversationContext(() => progress.snapshot());
  progress.request("提取字幕并保存", page);
  progress.observe({ type: "agent_event", event: { kind: "agent_start" } });
  const inner = runtime.session["session"];

  if (!inner) throw new Error("会话没有建成");

  const tool = (name: string) => {
    const definition = inner.getToolDefinition(name);

    if (!definition) throw new Error(`没有 ${name}`);

    // SAFETY: browser_run 与 artifacts 的 execute 不读取 ctx 参数。
    return (params: Record<string, string>, id = `call-${name}-${Math.random()}`) => definition.execute(id, params, undefined, undefined, {} as never);
  };

  const unknownResults = () => (progress.snapshot().results ?? []).filter(item => item.status === "unknown");

  return { runtime, frames, messages, run: tool("browser_run"), artifacts: tool("artifacts"), unknownResults };
}

/** 一个程序里的 browser.js 运行到一半报错（可能已改页面），留下一条结果未知的页面脚本。 */
async function leaveUnknownScript(h: Awaited<ReturnType<typeof lead>>) {
  await expect(h.run({ code: 'return await browser.js({code:"window.__x=1; JSON.parse(\'{\')"});' }, "call_failed_script")).rejects.toThrow(/in JSON/);
  expect(h.unknownResults().map(item => item.tool)).toEqual(["js"]);
}

const FETCH_AND_SAVE = `const snap = await browser.snapshot();
const res = await browser.fetch({url:"http://video.test/api/subtitle?vid=BV1&lan=zh-CN"});
const lines = JSON.parse(res.text).body.map(row => row.content);
const receipt = await browser.saveFile({filename:"字幕.txt", content: lines.join("\\n")+"\\n"});
return {sawButton: snap.text.includes("字幕"), receipt};`;

describe("页面脚本结果未知时 browser_run 的逐步放行", () => {
  it("1/6. 读页 + GET 取数 + saveFile 的程序照常完成，文件存成，未知结果仍待核查", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      const result = await h.run({ code: FETCH_AND_SAVE });
      expect(JSON.parse(textOf(result)).value).toEqual({ sawButton: true, receipt: { filename: "字幕.txt", chars: 8, lines: 2, overwritten: false } });
      expect(h.frames.map(frame => frame.name)).toEqual(["js", "snapshot", "fetch"]);
      expect(textOf(await h.artifacts({ command: "get", filename: "字幕.txt" }))).toBe("第一句\n第二句\n");
      // 6. 放行取数和存文件不等于核查过那次页面脚本。
      expect(h.unknownResults().map(item => item.tool)).toEqual(["js"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("2. 同一程序里改页面的一步仍被停下：前面的取数照做，click 不发出", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      await expect(h.run({ code: 'await browser.fetch({url:"http://video.test/api/subtitle"}); await browser.click({target:"#save"}); return "done";' })).rejects.toThrow(/当前写入已暂停/);
      expect(h.frames.map(frame => frame.name)).toEqual(["js", "fetch"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("3. 带 body 的 POST 取数照旧停下", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      await expect(h.run({ code: 'return await browser.fetch({url:"http://video.test/api/save", method:"POST", body:"x=1"});' })).rejects.toThrow(/当前写入已暂停/);
      expect(h.frames.map(frame => frame.name)).toEqual(["js"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("4. 结果未知的页面脚本不会被自动重做", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      await expect(h.run({ code: 'return await browser.js({code:"(() => 1)()"});' })).rejects.toThrow(/不能自动重做/);
      expect(h.frames.map(frame => frame.name)).toEqual(["js"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("5. artifacts 文件工具照常可用", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      await h.artifacts({ command: "create", filename: "notes.md", content: "字幕摘要\n" });
      expect(textOf(await h.artifacts({ command: "get", filename: "notes.md" }))).toBe("字幕摘要\n");
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("7. 编译不过的页面脚本不留未知结果，下一步照常执行", async () => {
    const h = await lead();

    try {
      await expect(h.run({ code: 'return await browser.js({code:"return 1"});' })).rejects.toThrow(/脚本未运行/);
      expect(h.unknownResults()).toEqual([]);
      await expect(h.run({ code: 'await browser.click({target:"#subtitle"}); return "clicked";' })).resolves.toBeDefined();
      expect(h.frames.map(frame => frame.name)).toEqual(["js", "click"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("8. 宿主读文档状态的探测照常运行，未知结果仍待核查", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      const result = await h.run({ code: 'return await browser.waitForLoad({state:"load", timeoutMs:3000});' });
      expect(JSON.parse(textOf(result)).value).toMatchObject({ readyState: "complete", state: "load" });
      expect(h.frames.filter(frame => frame.name === "js").length).toBeGreaterThan(1);
      expect(h.unknownResults().map(item => item.tool)).toEqual(["js"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("9. 夹带模型代码的探测仍被挡住", async () => {
    const h = await lead();

    try {
      await leaveUnknownScript(h);
      await expect(h.run({ code: 'return await browser.scrollToBottomUntil({condition:"document.title.length > 0", maxSteps:1, timeoutMs:2000});' })).rejects.toThrow(/不能自动重做/);
      expect(h.frames.filter(frame => frame.name === "js")).toHaveLength(1);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);
});
