import { beforeEach, describe, expect, it, vi } from "vitest";

function installChrome(opts?: {
  domRect?: { x: number; y: number; width: number; height: number } | null;
  domError?: string;
}) {
  const executeScript = vi.fn(async (details: {
    target: { tabId: number };
    files?: string[];
    func?: (...args: any[]) => any;
    args?: any[];
  }) => {
    if (details.files) {
      return [{ frameId: 0, result: undefined }];
    }
    if (typeof details.func === "function") {
      // 模拟页面 ISOLATED world 中执行
      // 若模拟 domops 抛错或未找到
      if (opts?.domError) {
        return [{ frameId: 0, result: { ok: false, error: opts.domError } }];
      }
      if (opts?.domRect !== undefined) {
        return [{ frameId: 0, result: { ok: true, rect: opts.domRect } }];
      }
      return [{ frameId: 0, result: undefined }];
    }
    return [{ frameId: 0, result: undefined }];
  });

  vi.stubGlobal("chrome", {
    debugger: { onDetach: { addListener: vi.fn() }, sendCommand: vi.fn() },
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      query: vi.fn(async () => [{ id: 101, active: true }]),
      get: vi.fn(async (id: number) => ({ id, active: true })),
      update: vi.fn(),
    },
  });
  return executeScript;
}

describe("click & mark robustness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("当 DOM 未找到元素时，click 抛明确错误，绝不裸抛 reading 'x'", async () => {
    installChrome({ domError: "未找到目标元素：#missing-btn" });
    const { click } = await import("../src/background/exec/input.js");

    await expect(click({ target: "#missing-btn" })).rejects.toThrow("未找到目标元素：#missing-btn");
    await expect(click({ target: "#missing-btn" })).rejects.not.toThrow(/reading 'x'/);
  });

  it("当 targetRect 为 null 或异常结构时，click 防御性抛出业务错误", async () => {
    installChrome({ domRect: null });
    const { click } = await import("../src/background/exec/input.js");

    await expect(click({ target: "#invalid-rect" })).rejects.toThrow(/未找到目标元素/);
    await expect(click({ target: "#invalid-rect" })).rejects.not.toThrow(/reading 'x'/);
  });

  it("归档 / Archive 目标会触发 held 拦阻进入就地确认", async () => {
    installChrome({ domRect: { x: 100, y: 200, width: 80, height: 32 } });
    const { click } = await import("../src/background/exec/input.js");

    const resZh = await click({ target: "#archive-btn", label: "归档会话" });
    expect(resZh).toEqual({ clicked: false, held: true });

    const resEn = await click({ target: "#archive-btn-en", label: "Archive" });
    expect(resEn).toEqual({ clicked: false, held: true });
  });

  it("mark 未带 actions 但 label 为「待归档」时自动注入隐式 actions", async () => {
    const executeScript = installChrome({ domRect: { x: 150, y: 250, width: 90, height: 36 } });
    const { mark } = await import("../src/background/exec/input.js");

    const res = await mark({ target: "#archive-item", label: "待归档" });
    expect(res).toEqual({ marked: true });

    const markCall = executeScript.mock.calls.find(([details]) =>
      Array.isArray(details.args) && details.args[1] === "待归档"
    );
    const passedActions = markCall![0].args?.[4];
    expect(passedActions).toEqual([
      { id: "confirm", label: "归档" },
      { id: "cancel", label: "取消" },
    ]);
  });
});
