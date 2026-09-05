import { beforeEach, describe, expect, it, vi } from "vitest";

function installChrome() {
  const executeScript = vi.fn(async (details: {
    target: { tabId: number };
    files?: string[];
    func?: unknown;
    args?: unknown[];
  }) => [{ frameId: 0, result: undefined }]);
  vi.stubGlobal("chrome", {
    debugger: { onDetach: { addListener: vi.fn() } },
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(async () => []),
    },
  });
  return executeScript;
}

describe("hideUserControlBanners", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("SW 内存集合为空时仍清理显式当前页", async () => {
    const executeScript = installChrome();
    const { hideUserControlBanners } = await import("../src/background/exec/input.js");

    await hideUserControlBanners(73);

    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 73 }, files: ["content-cursor.js"] }),
    );
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 73 }, args: [false, null] }),
    );
  });

  it("显式当前页与内存追踪页一起清理", async () => {
    const executeScript = installChrome();
    const { hideUserControlBanners, showUserControlBanner } = await import(
      "../src/background/exec/input.js"
    );
    await showUserControlBanner(41);
    executeScript.mockClear();

    await hideUserControlBanners(73);

    const hiddenTabIds = executeScript.mock.calls
      .filter(([details]) => details.args?.[0] === false)
      .map(([details]) => details.target.tabId)
      .sort((a, b) => a - b);
    expect(hiddenTabIds).toEqual([41, 73]);
  });
});
