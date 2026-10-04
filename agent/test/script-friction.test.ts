// 脚本摩擦：模型意图对，但 browser_run 报错含糊、js 取到的数据存不成文件（docs/evals/20261004-script-friction.md）。
// 先列失败方式，每条对应下面一个断言：
// B2-1 browser.snapshot(null) 这类空参数被拒（“Browser parameters must be an object”）；
// B2-2 位置参数 browser.sleep(1000) 的报错不说该怎么写；
// B2-3 不存在的方法只报 “not a function”，不说有哪些方法；
// B3-1 程序里写 document/window/Blob/fetch 只得到裸 ReferenceError，不指向 browser.js / browser.saveFile；
// B3-2 反向过宽：自己写错的局部变量也被说成“没有页面全局”；typeof window 不再是 "undefined"；
// B4-1 js 加 saveAs 后正文仍回到模型；或文件内容、侧栏卡片与返回值不一致；
// B4-2 saveAs 被当成页面脚本参数发给扩展；
// B4-3 文件名不合规时脚本已经在页面上跑了；超过 256000 字仍保存；没有返回值时存了空文件；
// B4-4 没有文件区（worker）时仍向模型宣传 saveAs。
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { runBrowserProgram } from "../src/browser-program.js";
import { createBrowserTools } from "../src/tools.js";
import { ToolRpc } from "../src/rpc.js";
import { createArtifactStore } from "../src/artifacts-tool.js";

/** 程序里每个 browser.* 调用最终交给宿主的那一跳。 */
type ProgramCall = Parameters<typeof runBrowserProgram>[0]["call"];

describe("B2 browser_run 参数与方法名", () => {
  it("B2-1 null / 不传参数都当作 {}", async () => {
    const call = vi.fn<ProgramCall>(async () => ({ text: "ok" }));
    const result = await runBrowserProgram({ code: "const a=await browser.snapshot(null); const b=await browser.snapshot(); return a.text+b.text;", call });
    expect(result.value).toBe("okok");
    expect(call.mock.calls.map(c => c[1])).toEqual([{}, {}]);
  });

  it("B2-2 位置参数的报错写明要传一个对象", async () => {
    await expect(runBrowserProgram({ code: "await browser.sleep(1000);", call: vi.fn() }))
      .rejects.toThrow("browser.sleep takes one object of named fields, e.g. browser.sleep({...}); got number");
  });

  it("B2-3 不存在的方法列出可用方法名", async () => {
    const error = await runBrowserProgram({ code: "return await browser.getText({target:'#a'});", call: vi.fn(), saveFile: vi.fn() }).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/^browser\.getText is not a browser method\. Available: /);
    expect(error?.message).toContain("snapshot, click");
    expect(error?.message).toContain("saveFile");
    // 只列规范名，不重复 camelCase 别名。
    expect(error?.message).not.toContain("doubleClick");
  });
});

describe("B3 程序里写页面全局", () => {
  const HINT = /^browser_run has no page globals such as (\w+): run page code with await browser\.js\(\{code: "\.\.\."\}\), save text with await browser\.saveFile\(\{filename, content\}\), and wait with await browser\.sleep\(\{ms\}\)\.$/;

  it.each(["return document.title;", "return window.innerWidth;", "new Blob(['a']); return 1;", "await fetch('/x');", "return location.href;", "return localStorage.a;", "return navigator.userAgent;", "await new Promise(r=>setTimeout(r,10));"])("B3-1 %s", async code => {
    const error = await runBrowserProgram({ code, call: vi.fn(), saveFile: vi.fn() }).then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(HINT);
  });

  it("B3-2 自己的拼写错误照原样报，typeof 探测不受影响", async () => {
    await expect(runBrowserProgram({ code: "return rowz.length;", call: vi.fn() })).rejects.toThrow("'rowz' is not defined");
    expect((await runBrowserProgram({ code: "return typeof window;", call: vi.fn() })).value).toBe("undefined");
  });
});

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;

function textOf(result: Result): string {
  const first = result.content[0];

  if (first?.type !== "text") throw new Error("工具结果不是文本");

  return first.text;
}

describe("B4 js 的 saveAs", () => {
  /** 页面脚本的返回值：字符串、可 JSON 化的对象，或没有返回值。 */
  type PageValue = string | { rows: number[] } | undefined;

  function setup(pageValue: PageValue) {
    const frames: Array<{ name: string; params: object }> = [];
    const events: AgentUiEvent[] = [];

    const rpc = new ToolRpc(frame => {
      frames.push({ name: frame.name, params: frame.params });
      setTimeout(() => rpc.handleResult(frame.id, true, { value: pageValue }), 0);
    });

    const store = createArtifactStore(event => events.push(event));
    const tools = createBrowserTools(rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, files: () => store });
    const js = tools.find(tool => tool.name === "js")!;

    const run = (params: { code: string; saveAs?: string }) => {
      // SAFETY: js 工具的 execute 不读取 ctx 参数。
      const ctx = {} as never;

      return js.execute(`call-js-${Math.random()}`, params, undefined, undefined, ctx);
    };

    return { frames, events, store, run, js };
  }

  it("B4-1/2 字符串结果存成文件，模型只拿到 {filename, chars, lines}", async () => {
    const { frames, events, store, run } = setup("第一行\n第二行\n");
    const result = await run({ code: "(() => document.body.innerText)()", saveAs: "subs.txt" });
    expect(textOf(result)).toBe('{"filename":"subs.txt","chars":8,"lines":2}');
    expect(JSON.stringify(result)).not.toContain("第一行");
    expect(store.get("subs.txt")).toBe("第一行\n第二行\n");
    expect(events).toEqual([{ kind: "artifact", action: "saved", filename: "subs.txt", content: "第一行\n第二行\n" }]);
    expect(frames).toEqual([{ name: "js", params: { code: "(() => document.body.innerText)()" } }]);
  });

  it("B4-1 对象结果按 JSON 文本保存", async () => {
    const { store, run } = setup({ rows: [1, 2] });
    expect(textOf(await run({ code: "(() => ({rows:[1,2]}))()", saveAs: "rows.json" }))).toBe('{"filename":"rows.json","chars":14,"lines":1}');
    expect(store.get("rows.json")).toBe('{"rows":[1,2]}');
  });

  it("B4-3 文件名不合规时脚本不运行；超限与无返回值不保存", async () => {
    const bad = setup("x");
    await expect(bad.run({ code: "1", saveAs: "../x.txt" })).rejects.toThrow(/文件名无效/);
    expect(bad.frames).toEqual([]);

    const big = setup("a".repeat(256001));
    await expect(big.run({ code: "1", saveAs: "big.txt" })).rejects.toThrow(/文件过大（256001 字符，上限 256000）/);
    expect(big.events).toEqual([]);

    const none = setup(undefined);
    await expect(none.run({ code: "1", saveAs: "none.txt" })).rejects.toThrow(/没有返回值/);
    expect(none.events).toEqual([]);
  });

  it("B4-4 没有文件区时不提 saveAs", () => {
    const rpc = new ToolRpc(() => { throw new Error("不应发出 RPC"); });
    const js = createBrowserTools(rpc).find(tool => tool.name === "js")!;
    expect(JSON.stringify(js.parameters)).not.toContain("saveAs");
    expect(js.description).not.toContain("saveAs");
    expect(setup("x").js.description).toContain("saveAs");
  });
});
