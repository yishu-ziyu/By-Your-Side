/**
 * CAP-02B 正式入口接线：createBrowserTools / browser_run 必须把
 * button、position、wheel、keyDown 等参数原样派发到扩展 RPC。
 * 期望值来自派发账本（mock rpc），不测 pointer-input 纯函数。
 */
import { describe, expect, it, vi } from "vitest";
import { createBrowserTools } from "../src/tools.js";
import { runBrowserProgram } from "../src/browser-program.js";
import { REALTIME_BROWSER_TOOL_NAMES } from "../src/realtime-browser-tools.js";
import type { ElementPosition, MouseButton } from "../../shared/pointer-input.js";

/**
 * CAP-02B input primitives forward their arguments verbatim to the extension RPC, so the mock
 * records one object per tool. Each primitive sends only its own subset, so every field is
 * optional; the field types come from shared/pointer-input.ts and the CAP-02B tool schemas in
 * agent/src/tools.ts, not from an unparsed payload dictionary.
 */
interface InputPrimitiveParams {
  target?: string;
  point?: [number, number];
  position?: ElementPosition;
  button?: MouseButton;
  clickCount?: number;
  force?: boolean;
  label?: string;
  deltaX?: number;
  deltaY?: number;
  key?: string;
}

function execute(tools: ReturnType<typeof createBrowserTools>, name: string, params: unknown) {
  const tool = tools.find((t) => t.name === name);

  if (!tool) throw new Error(`missing tool ${name}`);

  return tool.execute(`${name}-call`, params as never, undefined, undefined, {} as never);
}

function harness() {
  const rpc = {
    call: vi.fn(async (name: string, params: InputPrimitiveParams) => {
      if (name === "click") return { clicked: true };

      if (name === "double_click") return { doubleClicked: true };

      if (name === "wheel") return { wheeled: true, point: params.point ?? [10, 20] };

      if (name === "mouse_down") return { down: true, point: [1, 2], button: params.button ?? "left" };

      if (name === "mouse_up") return { up: true, point: [1, 2], button: params.button ?? "left" };

      if (name === "key_down") return { down: true, key: params.key };

      if (name === "key_up") return { up: true, key: params.key };

      if (name === "release_held_inputs") return { releasedKeys: [], releasedButtons: [] };

      if (name === "paste") throw new Error("PASTE_HOST_BLOCKED: no clipboard bridge");

      if (name === "html5_drag") return { dragged: false, gap: "no_intercept_payload", detail: "gap" };

      return {};
    }),
    ensureToolCall() {},
    markCallRejected() {},
    noteToolFact() {},
  };

  const tools = createBrowserTools(rpc as never, undefined, undefined, () => true, {
    epoch: () => 1,
    canWrite: () => true,
  });

  return { rpc, tools };
}

describe("CAP-02B 正式入口接线", () => {
  it("click 经 createBrowserTools 原样传递 button 与 position", async () => {
    const { rpc, tools } = harness();
    await execute(tools, "click", {
      target: "#btn",
      button: "right",
      position: { x: 3, y: 7 },
      clickCount: 2,
      force: true,
    });
    expect(rpc.call.mock.calls.some((c) => c[0] === "click")).toBe(true);
    const params = rpc.call.mock.calls.find((c) => c[0] === "click")![1] as InputPrimitiveParams;
    expect(params).toMatchObject({
      target: "#btn",
      button: "right",
      position: { x: 3, y: 7 },
      clickCount: 2,
      force: true,
    });
  });

  it("wheel / key_down 经正式工具派发到扩展 RPC 名", async () => {
    const { rpc, tools } = harness();
    await execute(tools, "wheel", { point: [100, 200], deltaX: 0, deltaY: 120 });
    await execute(tools, "key_down", { key: "Shift" });
    expect(rpc.call.mock.calls.find((c) => c[0] === "wheel")![1]).toMatchObject({
      point: [100, 200],
      deltaY: 120,
    });
    expect(rpc.call.mock.calls.find((c) => c[0] === "key_down")![1]).toMatchObject({ key: "Shift" });
  });

  it("browser_run camelCase 别名派发规范 RPC（含 button/position）", async () => {
    const call = vi.fn(async (name: string, _params: InputPrimitiveParams = {}, _id?: string) => {
      if (name === "click") return { clicked: true };

      if (name === "wheel") return { wheeled: true, point: [5, 6] };

      if (name === "key_down") return { down: true, key: "ControlOrMeta" };

      if (name === "mouse_down") return { down: true, point: [5, 6], button: "left" };

      if (name === "release_held_inputs") return { releasedKeys: ["ControlOrMeta"], releasedButtons: ["left"] };
      throw new Error(`unexpected ${name}`);
    });

    const result = await runBrowserProgram({
      code: `
        const c = await browser.click({ target: "#a", button: "middle", position: { x: 1, y: 2 } });
        const w = await browser.wheel({ point: [5, 6], deltaY: 40 });
        const k = await browser.keyDown({ key: "ControlOrMeta" });
        const m = await browser.mouseDown({ point: [5, 6] });
        const r = await browser.releaseHeldInputs({});
        return { c, w, k, m, r };
      `,
      call,
    });

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      "click",
      "wheel",
      "key_down",
      "mouse_down",
      "release_held_inputs",
    ]);
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      target: "#a",
      button: "middle",
      position: { x: 1, y: 2 },
    });
    expect(result.value).toMatchObject({
      w: { wheeled: true },
      k: { down: true },
      r: { releasedKeys: ["ControlOrMeta"] },
    });
  });

  it("html5_drag / paste 经工具表可达；不进入 Realtime 固定工具表", async () => {
    const { tools } = harness();
    const names = tools.map((t) => t.name);

    for (const name of [
      "wheel",
      "mouse_down",
      "mouse_up",
      "key_down",
      "key_up",
      "release_held_inputs",
      "paste",
      "html5_drag",
    ]) {
      expect(names).toContain(name);
      expect(REALTIME_BROWSER_TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });
});
