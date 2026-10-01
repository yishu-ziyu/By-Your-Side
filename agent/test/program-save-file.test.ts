// browser.saveFile：browser_run 程序把手上的数据直接存成本会话文件（docs/evals/20261001-data-to-file.md 标准 1）。
// 先列失败方式，每条对应下面一个断言：
// 1. 内容回到模型上下文：工具结果、侧栏步骤（tool_start/tool_end）带了正文；
// 2. 程序与 artifacts 写进两个不同的文件区：artifacts get 读不到程序存的文件；
// 3. 侧栏没出卡片：没发 artifact saved 事件，或事件里的内容不是全文；
// 4. 超过 256000 字仍保存；5. 文件名不合规仍保存；6. 同名覆盖不说；
// 7. 没有文件区的会话（worker、artifacts 未启用）里仍列出或悄悄成功；
// 8. 程序中途被停后仍落盘；9. 非字符串内容被悄悄转成别的东西保存。
// 走生产装配（createConversationRuntime：真实会话、真实工具注册与接线），只看对外结果。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../../shared/protocol.js";
import { createBrowserTools } from "../src/tools.js";
import { ToolRpc } from "../src/rpc.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "../src/document-file.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;

/** 直接执行一个已注册工具；这些工具都不读 Pi 的扩展上下文。 */
function invoke(definition: ToolDefinition, params: Record<string, string>, signal?: AbortSignal): Promise<Result> {
  // SAFETY: 被测工具（browser_run、artifacts）的 execute 不读取 ctx 参数。
  const ctx = {} as never;

  return definition.execute(`call-${definition.name}-${Math.random()}`, params, signal, undefined, ctx);
}

function textOf(result: Result): string {
  const first = result.content[0];

  if (first?.type !== "text") throw new Error("工具结果不是文本");

  return first.text;
}

type Receipt = { filename: string; chars: number; lines: number; overwritten: boolean };

/** 程序返回值：browser_run 的文本结果是 {value, steps} 的 JSON；这里的程序都返回 saveFile 回执或一个字符串。 */
function valueOf(result: Result): Receipt | string {
  const parsed: { value: Receipt | string } = JSON.parse(textOf(result));

  return parsed.value;
}

async function lead() {
  const { createConversationRuntime } = await import("../src/conversation-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "bys-save-file-"));
  dirs.push(dir);
  const messages: ServerMessage[] = [];
  const runtime = await createConversationRuntime("default", msg => messages.push(msg), undefined, { memoryStore: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)) });
  // 生产会话把 Pi 循环放在私有字段 session 里；这里只读它注册的工具与清单。
  const inner = runtime.session["session"];

  if (!inner) throw new Error("会话没有建成");

  const tool = (name: string) => {
    const definition = inner.getToolDefinition(name);

    if (!definition) throw new Error(`没有 ${name}`);

    return (params: Record<string, string>, signal?: AbortSignal) => invoke(definition, params, signal);
  };

  const artifactEvents = () => messages.flatMap(msg => msg.type === "agent_event" && msg.event.kind === "artifact" ? [msg.event] : []);

  return { runtime, messages, inner, run: tool("browser_run"), artifacts: tool("artifacts"), artifactEvents };
}

// 830 行、每行 "0123456789" 加换行：字数 830 × 11 = 9130，行数 830（末尾换行不算新的一行）。
const ROWS_PROGRAM = 'const rows=[]; for(let i=0;i<830;i++) rows.push("0123456789"); return await browser.saveFile({filename:"subs.txt", content: rows.join("\\n")+"\\n"});';

const ROWS_CONTENT = "0123456789\n".repeat(830);

describe("browser.saveFile（生产装配的 Lead 会话）", () => {
  it("存进 artifacts 同一文件区，发同一张卡片，模型只拿到回执", async () => {
    const { runtime, messages, run, artifacts, artifactEvents } = await lead();

    try {
      const result = await run({ code: ROWS_PROGRAM });
      expect(valueOf(result)).toEqual({ filename: "subs.txt", chars: 9130, lines: 830, overwritten: false });

      // 3. 卡片：一条 saved 事件，带全文。
      expect(artifactEvents()).toEqual([{ kind: "artifact", action: "saved", filename: "subs.txt", content: ROWS_CONTENT }]);

      // 1. 正文不回到模型（工具结果）也不进侧栏步骤与其它事件。
      expect(JSON.stringify(result)).not.toContain("0123456789");
      const others = messages.filter(msg => !(msg.type === "agent_event" && msg.event.kind === "artifact"));
      expect(JSON.stringify(others)).not.toContain("0123456789");
      // 步骤里只记文件名与长度。
      const start = others.find(msg => msg.type === "agent_event" && msg.event.kind === "tool_start" && msg.event.name === "saveFile");
      expect(start && start.type === "agent_event" && start.event.kind === "tool_start" ? start.event.params : null).toEqual({ filename: "subs.txt", chars: 9130 });

      // 2. 同一文件区：artifacts 读得到全文；create 同名被拒。
      expect(textOf(await artifacts({ command: "get", filename: "subs.txt" }))).toBe(ROWS_CONTENT);
      await expect(artifacts({ command: "create", filename: "subs.txt", content: "x" })).rejects.toThrow(/已存在/);

      // 6. 同名再存：覆盖并在回执里写明；卡片再发一次。
      const again = await run({ code: 'return await browser.saveFile({filename:"subs.txt", content:"new\\n"});' });
      expect(valueOf(again)).toEqual({ filename: "subs.txt", chars: 4, lines: 1, overwritten: true });
      expect(textOf(await artifacts({ command: "get", filename: "subs.txt" }))).toBe("new\n");
      expect(artifactEvents().at(-1)).toEqual({ kind: "artifact", action: "saved", filename: "subs.txt", content: "new\n" });

      // 程序存的文件，artifacts update 也能接着改。
      await artifacts({ command: "update", filename: "subs.txt", old_str: "new", new_str: "newer" });
      expect(textOf(await artifacts({ command: "get", filename: "subs.txt" }))).toBe("newer\n");
    } finally {
      runtime.dispose();
    }
  }, 30_000);

  it("大小、文件名、内容类型不合规时不保存、不出卡片，程序如实失败", async () => {
    const { runtime, run, artifacts, artifactEvents } = await lead();

    try {
      // 4. 上限 256000：正好 256000 可存，多 1 字拒绝。
      const limit = await run({ code: 'return await browser.saveFile({filename:"big.txt", content:"a".repeat(256000)});' });
      expect(valueOf(limit)).toEqual({ filename: "big.txt", chars: 256000, lines: 1, overwritten: false });
      await expect(run({ code: 'return await browser.saveFile({filename:"over.txt", content:"a".repeat(256001)});' })).rejects.toThrow(/文件过大（256001 字符，上限 256000）/);

      // 5. 文件名：带目录、没扩展名、点开头都拒。
      for (const filename of ["../x.csv", "dir/x.csv", "noext", ".hidden.txt"]) {
        await expect(run({ code: `return await browser.saveFile({filename:${JSON.stringify(filename)}, content:"a"});` })).rejects.toThrow(/文件名无效/);
      }

      // 9. 内容必须是字符串，空内容也不存。
      await expect(run({ code: 'return await browser.saveFile({filename:"rows.json", content:[1,2]});' })).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(run({ code: 'return await browser.saveFile({filename:"empty.txt", content:""});' })).rejects.toThrow(/INVALID_ARGUMENT/);

      expect(artifactEvents().map(event => event.filename)).toEqual(["big.txt"]);
      await expect(artifacts({ command: "get", filename: "over.txt" })).rejects.toThrow(/找不到/);
    } finally {
      runtime.dispose();
    }
  }, 30_000);

  it("8. 程序中途被停：停在保存之前就不落盘", async () => {
    const { runtime, run, artifacts, artifactEvents } = await lead();

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      await expect(run({ code: 'await browser.sleep({ms:2000}); return await browser.saveFile({filename:"late.txt", content:"x"});' }, controller.signal)).rejects.toThrow(/abort/i);
      expect(artifactEvents()).toEqual([]);
      await expect(artifacts({ command: "get", filename: "late.txt" })).rejects.toThrow(/找不到/);
    } finally {
      runtime.dispose();
    }
  }, 30_000);

  it("本机循环（Node 托管）仍提供 download_save_as、downloadSaveAs、spawn_worker 与分派助手的提示词", async () => {
    const { runtime, inner } = await lead();

    try {
      expect(inner.getActiveToolNames()).toContain("download_save_as");
      expect(inner.getToolDefinition("browser_run")!.description).toContain("downloadSaveAs");
      expect(inner.getActiveToolNames()).toContain("spawn_worker");
      const state: { systemPrompt?: string; messages: unknown[] } = inner.agent.state;
      expect(state.systemPrompt).toContain("# Parallel workers");
      expect(state.systemPrompt).toContain("spawn_worker");
    } finally {
      runtime.dispose();
    }
  }, 30_000);
});

describe("7. 没有文件区时 saveFile 不可用", () => {
  // 这两个用例的程序只走 saveFile 或 typeof，不发 RPC；发出任何帧都算失败。
  const rpc = () => new ToolRpc(frame => { throw new Error(`不应发出 RPC：${frame.name}`); });

  const runIn = (tools: ToolDefinition[], code: string) => {
    const run = tools.find(tool => tool.name === "browser_run");

    if (!run) throw new Error("没有 browser_run");

    return invoke(run, { code });
  };

  it("没接文件区（worker）：描述不提、程序里没有这个方法", async () => {
    const tools = createBrowserTools(rpc());
    expect(tools.find(tool => tool.name === "browser_run")!.description).not.toContain("saveFile");
    expect(valueOf(await runIn(tools, "return typeof browser.saveFile;"))).toBe("undefined");
  });

  it("接了但本会话没有文件区（artifacts 未启用）：调用如实失败", async () => {
    const tools = createBrowserTools(rpc(), undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, files: () => undefined });
    await expect(runIn(tools, 'return await browser.saveFile({filename:"a.txt", content:"a"});')).rejects.toThrow(/没有文件区/);
  });
});
