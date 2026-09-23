/**
 * CAP-02A：browser_run arm → 动作 → wait 串行队列语义。
 * 反例：阻塞式先 wait 再 click 会死锁；arm 必须立即返回 token。
 */
import { describe, expect, it, vi } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBrowserProgram } from "../src/browser-program.js";
import { hostDownloadSaveAs, createDownloadArmDir, assertAbsoluteSavePath } from "../src/download-artifacts.js";

describe("CAP-02A arm/wait 串行队列", () => {
  it("armEvent 立即返回 token，不阻塞后续 click；再 waitEvent 消费", async () => {
    const order: string[] = [];
    let armedToken = "";
    const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
      order.push(name);
      if (name === "arm_event") {
        armedToken = "evt_popup_1_1_testhost";
        return { token: armedToken, type: params.type, tabId: 1, timeoutMs: 10_000 };
      }
      if (name === "click") {
        return { clicked: true, newTab: { tabId: 2, url: "https://popup.test/" } };
      }
      if (name === "wait_event") {
        expect(params.token).toBe(armedToken);
        return {
          token: armedToken,
          type: "popup",
          tabId: 1,
          popup: { tabId: 2, url: "https://popup.test/", label: "tab:2" },
        };
      }
      throw new Error(`unexpected ${name}`);
    });

    const result = await runBrowserProgram({
      code: `
        const arm = await browser.armEvent({ type: "popup", timeoutMs: 5000 });
        const click = await browser.click({ target: "a#open" });
        const popup = await browser.waitEvent({ token: arm.token });
        return { arm, click, popup };
      `,
      call,
    });

    expect(order).toEqual(["arm_event", "click", "wait_event"]);
    expect(result.value).toMatchObject({
      arm: { token: armedToken },
      popup: { popup: { tabId: 2 } },
    });
  });

  it("伪造 token 在 wait_event 边界失败（扩展侧会拒；此处模拟）", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "wait_event") throw new Error("INVALID_ARGUMENT: unknown or model-minted event token");
      throw new Error(`unexpected ${name}`);
    });
    await expect(
      runBrowserProgram({
        code: `return await browser.waitEvent({ token: "I-forged-this" });`,
        call,
      }),
    ).rejects.toThrow(/model-minted|unknown/i);
  });

  it("armEvent(download) 由宿主补 downloadPath 再 RPC", async () => {
    const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === "arm_event") {
        expect(typeof params.downloadPath).toBe("string");
        expect(String(params.downloadPath).startsWith("/")).toBe(true);
        return { token: "evt_download_1_1_aabbccdd", type: "download", tabId: 1, timeoutMs: 10_000, downloadPath: params.downloadPath };
      }
      throw new Error(`unexpected ${name}`);
    });
    const result = await runBrowserProgram({
      code: `return await browser.armEvent({ type: "download" });`,
      call,
    });
    expect(result.value).toMatchObject({ type: "download", token: expect.stringMatching(/^evt_download_/) });
    rmSync(String((result.value as { downloadPath?: string }).downloadPath), { recursive: true, force: true });
  });
});

describe("CAP-02A download 宿主 saveAs", () => {
  it("轮询临时目录复制到绝对路径；拒绝相对路径", async () => {
    expect(() => assertAbsoluteSavePath("relative.bin")).toThrow(/absolute/);
    const dir = createDownloadArmDir("test");
    writeFileSync(join(dir, "report.pdf"), "PDFDATA");
    const dest = join(tmpdir(), `bys-cap02a-save-${Date.now()}.pdf`);
    try {
      const saved = await hostDownloadSaveAs({
        downloadId: "dl_1",
        path: dest,
        timeoutMs: 2000,
        stat: async () => ({
          downloadId: "dl_1",
          tabId: 9,
          url: "blob:https://example/x",
          suggestedFilename: "report.pdf",
          path: null,
          failure: null,
          completed: true,
          cancelled: false,
          downloadPath: dir,
        }),
      });
      expect(saved.bytes).toBe(7);
      expect(saved.path).toBe(dest);
      expect(saved.tabId).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dest, { force: true });
    }
  });

  it("failure/cancel 不得 saveAs 成功", async () => {
    await expect(
      hostDownloadSaveAs({
        downloadId: "dl_2",
        path: join(tmpdir(), "x.bin"),
        timeoutMs: 200,
        stat: async () => ({
          downloadId: "dl_2",
          tabId: 1,
          url: "https://x",
          suggestedFilename: "x.bin",
          path: null,
          failure: "canceled",
          completed: false,
          cancelled: true,
          downloadPath: join(tmpdir(), "missing-cap02a"),
        }),
      }),
    ).rejects.toThrow(/canceled|failed/i);
  });
});

describe("CAP-02A pageInfo dialog 字段", () => {
  it("pageInfo 附带 dialog_info", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "list_tabs") return { tabs: [{ id: 3, title: "App", url: "https://app.test/", working: true }] };
      if (name === "js") return { value: { href: "https://app.test/", title: "App", readyState: "complete" } };
      if (name === "dialog_info") return { dialog: { type: "confirm", message: "删除？", tabId: 3 } };
      throw new Error(name);
    });
    const result = await runBrowserProgram({
      code: `return await browser.pageInfo({});`,
      call,
    });
    expect(result.value).toMatchObject({
      tabId: 3,
      dialog: { type: "confirm", message: "删除？" },
    });
  });
});
