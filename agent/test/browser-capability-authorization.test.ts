/**
 * FIX-01 宿主链：createBrowserTools → call → ToolRpc。
 * 期望值来自外部判据（未授权不得派发；授权后四入口路径同一规范化结果；
 * 禁用/取消后业务派发为 0）。扩展侧用 mock，不依赖真实 Chrome。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTools } from "../src/tools.js";
import { TaskUploadLedger } from "../src/upload-paths.js";

const SECRET = "UNAUTH_SECRET_BODY_should_never_appear";

function execute(tools: ReturnType<typeof createBrowserTools>, name: string, params: unknown, signal?: AbortSignal) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(`${name}-call`, params as never, signal, undefined, {} as never);
}

function harness(opts: {
  ledger?: TaskUploadLedger;
  canExecute?: (name: string) => boolean;
  canWrite?: () => boolean;
  epoch?: () => number;
}) {
  const rejected: string[] = [];
  const rpc = {
    call: vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === "upload_file") {
        return {
          uploaded: true,
          files: (params.paths as string[]).map((p) => ({ name: p.split("/").pop() ?? p, size: 5 })),
        };
      }
      if (name === "fill") return { filled: true };
      if (name === "list_tabs") {
        return { tabs: [{ id: 1, title: "t", url: "https://x/", active: true, working: true }] };
      }
      if (name === "js") {
        // Playwright 兼容层在 setInputFiles 前会 inspect/tag；本测试只证明授权边界，返回“目标存在”。
        return { value: { count: 1, visible: true, token: "bys-auth", handleKind: "element", values: ["bys-auth"] } };
      }
      return {};
    }),
    ensureToolCall: vi.fn(),
    markCallRejected: vi.fn((id: string) => {
      rejected.push(id);
    }),
    noteToolFact: vi.fn(),
    getPageTarget: () => 1,
  };
  const tools = createBrowserTools(rpc as never, undefined, undefined, opts.canExecute ?? (() => true), {
    epoch: opts.epoch ?? (() => 1),
    canWrite: opts.canWrite ?? (() => true),
    ...(opts.ledger ? { uploadLedger: opts.ledger } : {}),
  });
  return { rpc, tools, rejected };
}

describe("FIX-01 上传共同调用边界（宿主链）", () => {
  const root = mkdtempSync(join(tmpdir(), "bys-auth-root-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "bys-auth-out-"));
  const allowed = join(root, "ok.txt");
  const unauthorized = join(outsideDir, "leak.txt");
  const historic = join(root, "historic.txt");
  writeFileSync(allowed, "ok-data");
  writeFileSync(unauthorized, SECRET);
  writeFileSync(historic, "old-in-downloads-dir");

  const ledger = new TaskUploadLedger([root]);
  const record = ledger.grant({ path: allowed, source: "user_provided", fileId: "task-ok" });

  it("同一未授权文件：独立 upload_file 拦下且不派发 RPC", async () => {
    const { rpc, tools, rejected } = harness({ ledger });
    await expect(
      execute(tools, "upload_file", { target: "#file", paths: [unauthorized] }),
    ).rejects.toThrow(/不在授权目录内|不属于本任务|未执行/);
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rejected.length).toBeGreaterThan(0);
    const dumped = JSON.stringify({ calls: rpc.call.mock.calls, rejected });
    expect(dumped).not.toContain(SECRET);
  });

  it("同一未授权文件：browser.upload_file / uploadFile 别名拦下且浏览器未接收", async () => {
    const { rpc, tools } = harness({ ledger });
    for (const code of [
      `await browser.upload_file({target:"#file",paths:${JSON.stringify([unauthorized])}});`,
      `await browser.uploadFile({target:"#file",paths:${JSON.stringify([unauthorized])}});`,
    ]) {
      rpc.call.mockClear();
      await expect(execute(tools, "browser_run", { code })).rejects.toThrow();
      expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(0);
    }
  });

  it("同一未授权文件：Playwright setInputFiles 拦下且不派发 upload_file", async () => {
    const { rpc, tools } = harness({ ledger });
    await expect(
      execute(tools, "browser_run", {
        api: "playwright",
        code: `await page.locator("#file").setInputFiles(${JSON.stringify(unauthorized)}); return "done";`,
      }),
    ).rejects.toThrow(/不在授权目录内|不属于本任务|未执行|授权/);
    expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(0);
  });

  it("目录内历史文件未经本任务登记：四入口均不派发", async () => {
    const { rpc, tools } = harness({ ledger });
    await expect(execute(tools, "upload_file", { target: "#file", paths: [historic] })).rejects.toThrow(
      /不属于本任务授权/,
    );
    await expect(
      execute(tools, "browser_run", {
        code: `await browser.uploadFile({target:"#file",paths:${JSON.stringify([historic])}});`,
      }),
    ).rejects.toThrow();
    expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(0);
  });

  it("授权文件：独立工具 / upload_file / uploadFile / setInputFiles 成功且路径身份一致", async () => {
    const expected = realpathSync(allowed);
    const { rpc, tools } = harness({ ledger });

    await execute(tools, "upload_file", { target: "#file", paths: [allowed] });
    await execute(tools, "upload_file", { target: "#file", paths: ["task-ok"] });
    await execute(tools, "browser_run", {
      code: `return await browser.upload_file({target:"#file",paths:${JSON.stringify([allowed])}});`,
    });
    await execute(tools, "browser_run", {
      code: `return await browser.uploadFile({target:"#file",paths:["task-ok"]});`,
    });
    await execute(tools, "browser_run", {
      api: "playwright",
      code: `await page.locator("#file").setInputFiles(${JSON.stringify(allowed)}); return "ok";`,
    });

    const uploads = rpc.call.mock.calls.filter((c) => c[0] === "upload_file");
    expect(uploads.length).toBe(5);
    for (const [, params] of uploads) {
      expect(params.paths).toEqual([expected]);
    }
    expect(record.path).toBe(expected);
  });

  it("禁用 upload_file 后，browser_run 别名也不能派发上传", async () => {
    const { rpc, tools } = harness({
      ledger,
      canExecute: (name) => name !== "upload_file",
    });
    await expect(
      execute(tools, "browser_run", {
        code: `await browser.uploadFile({target:"#file",paths:["task-ok"]});`,
      }),
    ).rejects.toThrow(/未启用/);
    expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(0);
  });

  it("禁用 fill 后，browser_run 不能完成同等写入", async () => {
    const { rpc, tools } = harness({
      ledger,
      canExecute: (name) => name !== "fill",
    });
    await expect(
      execute(tools, "browser_run", {
        code: `await browser.fill({target:"#name",value:"x"});`,
      }),
    ).rejects.toThrow(/未启用/);
    expect(rpc.call.mock.calls.filter((c) => c[0] === "fill")).toHaveLength(0);
  });

  it("abort 排队中：后续业务上传派发为 0", async () => {
    const controller = new AbortController();
    controller.abort();
    const { rpc, tools } = harness({ ledger });
    await expect(
      execute(tools, "upload_file", { target: "#file", paths: ["task-ok"] }, controller.signal),
    ).rejects.toThrow(/取消|abort/i);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("abort 进行中：已开始之后的后续上传派发为 0", async () => {
    const controller = new AbortController();
    let resolveFirst!: (v: { uploaded: boolean; files: Array<{ name: string; size: number }> }) => void;
    const { rpc, tools } = harness({ ledger });
    rpc.call.mockImplementationOnce(
      () =>
        new Promise<{ uploaded: boolean; files: Array<{ name: string; size: number }> }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = execute(
      tools,
      "browser_run",
      {
        code: `await browser.uploadFile({target:"#file",paths:["task-ok"]}); await browser.uploadFile({target:"#file",paths:["task-ok"]}); return "done";`,
      },
      controller.signal,
    );
    // 等第一次 upload 已进入 rpc.call
    await vi.waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveFirst({ uploaded: true, files: [{ name: "ok.txt", size: 5 }] });
    await expect(first).rejects.toThrow(/abort|取消|stopped/i);
    expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(1);
  });

  it("不传账本：非空上传被拒且无 RPC", async () => {
    const { rpc, tools, rejected } = harness({});
    await expect(
      execute(tools, "upload_file", { target: "#file", paths: [allowed] }),
    ).rejects.toThrow(/没有可上传的文件授权记录/);
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("空 paths 清空不要求账本内已有文件", async () => {
    const { rpc, tools } = harness({});
    await execute(tools, "upload_file", { target: "#file", paths: [] });
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect(rpc.call.mock.calls[0]![0]).toBe("upload_file");
    expect(rpc.call.mock.calls[0]![1]).toMatchObject({ paths: [] });
  });

  it("会话接线账本：本任务 fetch 刚落盘可上传；同目录未 grant 历史文件被拒", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "bys-auth-dl-"));
    const prev = process.env.SIDEAGENT_DOWNLOADS_DIR;
    process.env.SIDEAGENT_DOWNLOADS_DIR = downloads;
    try {
      // 与生产会话一致：账本根含当前 downloads 目录（defaultUploadRoots / fetchDownloadsDir）。
      const { defaultUploadRoots } = await import("../src/upload-paths.js");
      const { workerExecution } = await import("../src/fleet.js");
      const sessionLedger = new TaskUploadLedger(defaultUploadRoots());
      const session = { uploadLedger: sessionLedger, executionEpoch: () => 1, canWriteCurrentInput: () => true };
      const wired = workerExecution(() => session as never);
      expect(wired.uploadLedger).toBe(sessionLedger);

      writeFileSync(join(downloads, "historic-other-task.bin"), "stale");
      const body = "x".repeat(5000);
      const { rpc, tools } = harness({ ledger: sessionLedger });
      rpc.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
        if (name === "fetch") {
          return {
            url: "https://example.com/data",
            status: 200,
            ok: true,
            contentType: "text/plain",
            bytes: body.length,
            truncated: false,
            text: body,
          };
        }
        if (name === "upload_file") {
          return {
            uploaded: true,
            files: (params.paths as string[]).map((p) => ({ name: p.split("/").pop() ?? p, size: 5 })),
          };
        }
        return {};
      });

      await execute(tools, "fetch", { url: "https://example.com/data", savePath: "task-artifact.txt" });
      const artifact = realpathSync(join(downloads, "task-artifact.txt"));
      expect(sessionLedger.getByPath(artifact)?.source).toBe("task_artifact");

      await execute(tools, "upload_file", { target: "#file", paths: [artifact] });
      expect(rpc.call.mock.calls.filter((c) => c[0] === "upload_file")).toHaveLength(1);
      expect(rpc.call.mock.calls.find((c) => c[0] === "upload_file")![1].paths).toEqual([artifact]);

      const historic = join(downloads, "historic-other-task.bin");
      rpc.call.mockClear();
      await expect(
        execute(tools, "upload_file", { target: "#file", paths: [historic] }),
      ).rejects.toThrow(/不属于本任务授权/);
      expect(rpc.call).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.SIDEAGENT_DOWNLOADS_DIR;
      else process.env.SIDEAGENT_DOWNLOADS_DIR = prev;
      rmSync(downloads, { recursive: true, force: true });
    }
  });

  it("清理临时目录", () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
