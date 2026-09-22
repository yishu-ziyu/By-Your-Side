import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "conversation-A::writer";

async function loadReadElements(options: {
  resolveError?: string;
  resolvedTab?: { id: number | undefined | null };
} = {}) {
  vi.resetModules();

  const resolveReadableTab = options.resolveError
    ? vi.fn(async () => { throw new Error(options.resolveError); })
    : vi.fn(async (tabId: number) => options.resolvedTab ?? { id: tabId });

  vi.doMock("../src/background/state.js", () => ({
    getWorkingTabId: vi.fn(async () => 12),
    resolveReadableTab,
  }));

  return import("../src/background/exec/read-elements.js");
}

/** Mirrors read-element.test.ts: executeScript runs the real serialized page function synchronously against stubbed globals. */
function installScriptExecution(documentId?: string) {
  const executeScript = vi.fn(async (details: any) => [
    { result: details.func(...details.args), ...(documentId ? { documentId } : {}) },
  ]);

  vi.stubGlobal("chrome", { scripting: { executeScript } });

  return executeScript;
}

function installComputedStyle() {
  vi.stubGlobal("getComputedStyle", (el: any) => el.__style ?? {
    visibility: "visible", display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(0, 0, 0)", outline: "none", border: "none", textDecoration: "none", fontWeight: "400",
  });
}

function makeElement(overrides: Partial<{
  tagName: string;
  textContent: string;
  parentElement: any;
  getClientRects: () => unknown[];
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
}> = {}) {
  return {
    tagName: overrides.tagName ?? "DIV",
    textContent: overrides.textContent ?? "",
    parentElement: overrides.parentElement ?? null,
    getClientRects: overrides.getClientRects ?? (() => [{}]),
    getBoundingClientRect: overrides.getBoundingClientRect ?? (() => ({ x: 1.4, y: 2.6, width: 10.2, height: 20.9 })),
  } as any;
}

function installDocument(elements: unknown[]) {
  vi.stubGlobal("document", { querySelectorAll: vi.fn(() => elements), getElementById: () => null });
}

afterEach(() => {
  vi.doUnmock("../src/background/state.js");
  vi.unstubAllGlobals();
});

describe("read_elements", () => {
  it("selector 归一化为 loc=css:，原生 CSS 与 loc=css: 前缀等价", async () => {
    installDocument([makeElement({ textContent: "a" })]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();

    const raw = await readElements({ selector: "#list li" }, KEY);
    expect(raw.selector).toBe("loc=css:#list li");

    const prefixed = await readElements({ selector: "loc=css:#list li" }, KEY);
    expect(prefixed.selector).toBe("loc=css:#list li");
  });

  it("@ref 明确报错，不触发页面读取", async () => {
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: "@7" }, KEY)).rejects.toThrow(/@ref/);
  });

  it("非 loc=css: 的 loc= 形式明确报错", async () => {
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: "loc=xpath://div" }, KEY)).rejects.toThrow(/loc=css/);
  });

  it("空 selector 明确报错", async () => {
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: "" }, KEY)).rejects.toThrow(/selector/);
    await expect(readElements({ selector: "loc=css:" }, KEY)).rejects.toThrow(/CSS 选择器/);
  });

  it("limit 边界：0、201 与非整数报错", async () => {
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: "div", limit: 0 }, KEY)).rejects.toThrow(/limit/);
    await expect(readElements({ selector: "div", limit: 201 }, KEY)).rejects.toThrow(/limit/);
    await expect(readElements({ selector: "div", limit: 1.5 }, KEY)).rejects.toThrow(/limit/);
  });

  it("缺省 limit 为 60：61 个命中只取前 60 个并标记 truncated", async () => {
    const elements = Array.from({ length: 61 }, (_, i) => makeElement({ textContent: `item-${i}` }));
    installDocument(elements);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".item" }, KEY);
    expect(result.total).toBe(61);
    expect(result.truncated).toBe(true);
    expect(result.elements).toHaveLength(60);
    expect(result.elements[0]?.index).toBe(0);
    expect(result.elements[59]?.index).toBe(59);
  });

  it("命中数不超过 limit 时 truncated 为 false", async () => {
    installDocument([makeElement({ textContent: "a" }), makeElement({ textContent: "b" })]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x", limit: 5 }, KEY);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.elements).toHaveLength(2);
  });

  it("selector 无命中时返回 total:0 与空列表，不算错误", async () => {
    installDocument([]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: "#never-exists" }, KEY);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.elements).toEqual([]);
  });

  it("文本按 trim 后截 200 字", async () => {
    const raw = `  ${"文字".repeat(150)}  `;
    installDocument([makeElement({ textContent: raw })]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x" }, KEY);
    expect(result.elements[0]?.text).toHaveLength(200);
    expect(result.elements[0]?.text).toBe(raw.trim().slice(0, 200));
  });

  it("tagName 归一为小写", async () => {
    installDocument([makeElement({ tagName: "SPAN", textContent: "x" })]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: "span" }, KEY);
    expect(result.elements[0]?.tagName).toBe("span");
  });

  it("rect 取整为像素坐标", async () => {
    installDocument([makeElement({ textContent: "x", getBoundingClientRect: () => ({ x: 1.4, y: 2.6, width: 10.2, height: 20.9 }) })]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x" }, KEY);
    expect(result.elements[0]?.rect).toEqual({ x: 1, y: 3, width: 10, height: 21 });
  });

  it("visible 规则：无 client rects 或样式隐藏时为 false，否则为 true", async () => {
    const hiddenByDisplay = makeElement({ textContent: "h1" });
    hiddenByDisplay.__style = { visibility: "visible", display: "none", backgroundColor: "", color: "", outline: "", border: "", textDecoration: "", fontWeight: "" };
    const hiddenByRects = makeElement({ textContent: "h2", getClientRects: () => [] });
    const visibleOne = makeElement({ textContent: "v1" });
    installDocument([hiddenByDisplay, hiddenByRects, visibleOne]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x" }, KEY);
    expect(result.elements[0]?.visible).toBe(false);
    expect(result.elements[1]?.visible).toBe(false);
    expect(result.elements[2]?.visible).toBe(true);
  });

  it("style 原样传回六个计算样式字段", async () => {
    const element = makeElement({ textContent: "x" });
    element.__style = { visibility: "visible", display: "block", backgroundColor: "rgb(1, 2, 3)", color: "rgb(4, 5, 6)", outline: "rgb(0, 0, 0) solid 1px", border: "1px solid black", textDecoration: "underline", fontWeight: "700" };
    installDocument([element]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x" }, KEY);
    expect(result.elements[0]?.style).toEqual({
      backgroundColor: "rgb(1, 2, 3)", color: "rgb(4, 5, 6)", outline: "rgb(0, 0, 0) solid 1px", border: "1px solid black", textDecoration: "underline", fontWeight: "700",
    });
  });

  it("scopeLabels 按祖先 role 与可命名的最近文本收集，最多 4 条", async () => {
    const form = { tagName: "FORM", parentElement: null, getAttribute: (n: string) => (n === "aria-label" ? "登录表单" : null) };
    const element = makeElement({ textContent: "邮箱", parentElement: form });
    installDocument([element]);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: "input" }, KEY);
    expect(result.elements[0]?.scopeLabels).toEqual(["form: 登录表单"]);
  });

  it("记录并返回 documentId", async () => {
    installDocument([makeElement({ textContent: "x" })]);
    installComputedStyle();
    installScriptExecution("doc-42");
    const { readElements } = await loadReadElements();
    const result = await readElements({ selector: ".x" }, KEY);
    expect(result.documentId).toBe("doc-42");
  });

  it("非法 CSS 选择器语法明确报错", async () => {
    vi.stubGlobal("document", { querySelectorAll: () => { throw new Error("invalid selector"); }, getElementById: () => null });
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: "[" }, KEY)).rejects.toThrow(/无效的 CSS/);
  });

  it("标签页已关闭时明确报错", async () => {
    installScriptExecution();
    const { readElements } = await loadReadElements({ resolvedTab: { id: undefined } });
    await expect(readElements({ tabId: 12, selector: ".x" }, KEY)).rejects.toThrow(/已关闭/);
  });

  it("跨会话或未共享标签页的错误原样抛出，不回退到活动页", async () => {
    installScriptExecution();
    const { readElements } = await loadReadElements({ resolveError: "标签页属于其他会话或未向当前成员共享" });
    await expect(readElements({ tabId: 99, selector: ".x" }, KEY)).rejects.toThrow(/属于其他会话/);
  });

  it("输出超过安全上限时报错，不返回部分内容", async () => {
    const huge = Array.from({ length: 5 }, (_, i) => makeElement({ textContent: `huge-${i}` }));

    for (const element of huge) {
      element.__style = { visibility: "visible", display: "block", backgroundColor: "x".repeat(60_000), color: "", outline: "", border: "", textDecoration: "", fontWeight: "" };
    }

    installDocument(huge);
    installComputedStyle();
    installScriptExecution();
    const { readElements } = await loadReadElements();
    await expect(readElements({ selector: ".huge" }, KEY)).rejects.toThrow(/超过安全上限.*未返回部分内容/);
  });
});
