// 只装扩展的运行形态：调用必然失败的工具不列给模型（docs/evals/20261001-data-to-file.md 标准 3）。
// 失败方式：1. 扩展会话的 active 清单仍有 download_save_as / upload_file / file_chooser_set_files / paste；
// 2. browser_run 的描述或程序方法里仍有 downloadSaveAs / uploadFile / fileChooserSetFiles / paste；
// 3. 去掉这些写工具后「写能力不完整」闸门把通用页面 JS 一起关掉；4. saveFile 在扩展里反而不可用；
// 5. 请不到助手（没有 spawn_worker）时，系统提示词仍要求模型分派助手。
// 扩展形态由构建时的模块替换定义（extension/build.mjs 把 agent/src 的 `./config.js` 换成垫片）；
// 这里做同一个替换、用同一个垫片文件，其余都是生产装配。与 extension/test/inproc-fetch.test.ts 同理，
// 这处模块替换记入 anti-slop 基线（2026-10-01），直到运行形态可以注入为止。
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolName } from "../../shared/protocol.js";

vi.mock("../src/config.js", () => import("../../extension/src/inproc/shims/config.js"));

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GONE = ["download_save_as", "upload_file", "file_chooser_set_files", "paste", "spawn_worker"];

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;

function invoke(definition: ToolDefinition, params: Record<string, string>): Promise<Result> {
  // SAFETY: 被测工具（browser_run、js）的 execute 不读取 ctx 参数。
  const ctx = {} as never;

  return definition.execute(`call-${definition.name}`, params, undefined, undefined, ctx);
}

function textOf(result: Result): string {
  const first = result.content[0];

  if (first?.type !== "text") throw new Error("工具结果不是文本");

  return first.text;
}

describe("扩展形态的会话工具清单", () => {
  it("用不了的工具不列给模型，saveFile 与通用页面 JS 仍可用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bys-ext-tools-"));
    dirs.push(dir);
    // 诊断记录在本机默认写 dataDir 下；扩展形态的 dataDir 是空串，指到临时目录免得写进仓库。
    vi.stubEnv("SIDEAGENT_TRACE_DIR", join(dir, "traces"));
    const { createConversationRuntime } = await import("../src/conversation-runtime.js");
    const { MemoryStore, MEMORY_STORE_FILE } = await import("../src/memory-store.js");
    const { FileDocument } = await import("../src/document-file.js");
    const { createBrowserTools } = await import("../src/tools.js");
    const { ToolRpc } = await import("../src/rpc.js");
    const runtime = await createConversationRuntime("default", () => {}, undefined, { memoryStore: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)) });

    try {
      // 生产会话把 Pi 循环放在私有字段 session 里；这里只读它注册的工具与清单。
      const inner = runtime.session["session"];

      if (!inner) throw new Error("会话没有建成");
      const active = inner.getActiveToolNames();

      // 1. 工具清单读数
      expect(GONE.filter(name => active.includes(name))).toEqual([]);

      for (const name of ["artifacts", "browser_run", "js", "fetch", "download_cancel", "arm_event"]) expect(active).toContain(name);

      // 5. 系统提示词里没有分派助手的指令（本机对照见 program-save-file.test.ts 的本机用例）。
      const state: { systemPrompt?: string; messages: unknown[] } = inner.agent.state;
      expect(state.systemPrompt).toContain("You are By Your Side");
      expect(state.systemPrompt).not.toMatch(/spawn_worker|Parallel workers|delegate/i);

      // 2. browser_run 描述与程序方法
      const run = inner.getToolDefinition("browser_run");

      if (!run) throw new Error("没有 browser_run");
      expect(run.description).toContain("browser.saveFile({filename, content})");

      for (const word of ["downloadSaveAs", "uploadFile", "fileChooserSetFiles", "/paste/"]) expect(run.description).not.toContain(word);

      const listed: { value: string[] } = JSON.parse(textOf(await invoke(run, { code: "return Object.keys(browser);" })));
      expect(listed.value).toContain("saveFile");
      expect(listed.value).toContain("js");

      for (const name of [...GONE, "downloadSaveAs", "uploadFile", "fileChooserSetFiles"]) expect(listed.value).not.toContain(name);

      // 3. 闸门按生产接线的 canExecute（= 会话里这个工具是否 active）与模式隐藏判断，js 不因这些工具缺席而被拒。
      const sent: string[] = [];

      const rpc = new ToolRpc(frame => {
        sent.push(frame.name);
        setTimeout(() => rpc.handleResult(frame.id, true, { value: "ok" }), 0);
      });

      const tools = createBrowserTools(rpc, undefined, undefined, (name: ToolName) => active.includes(name), {
        epoch: () => 0, canWrite: () => true, isToolHiddenByMode: name => runtime.session.isToolHiddenByMode(name),
      });

      const js = tools.find(tool => tool.name === "js");

      if (!js) throw new Error("没有 js");
      expect(textOf(await invoke(js, { code: "1" }))).toContain("ok");
      expect(sent).toEqual(["js"]);
    } finally {
      runtime.dispose();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
