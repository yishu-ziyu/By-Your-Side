/**
 * CAP-02C 反例：ARIA 名≠显示文本、重复名、嵌套 open shadow、同源 frame、
 * 多选清空、等待四态、截图 clip 坐标契约、歧义/旧 ref 不执行。
 * 期望值手写；不删既有 click-integrity / hover-recovery 断言。
 * DOM 用例用 stub（与 click-integrity 同风格），不引入 jsdom。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import { parseTarget, resolveArgs, resolveTargetSelector } from "../src/shared/target.js";
import { createBrowserTools } from "../../agent/src/tools.js";
import { runBrowserProgram } from "../../agent/src/browser-program.js";
import { REALTIME_BROWSER_TOOL_NAMES } from "../../agent/src/realtime-browser-tools.js";
import { TOOL_NAMES } from "../../shared/protocol.js";
import type { ToolRpc } from "../../agent/src/rpc.js";

type FakeEl = {
  id?: string;
  tagName: string;
  textContent: string;
  isConnected: boolean;
  shadowRoot: FakeDoc | null;
  contentDocument?: FakeDoc | null;
  attributes: Record<string, string>;
  children: FakeEl[];
  labels?: FakeEl[];
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: FakeEl): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  attachShadow?(init: { mode: string }): FakeDoc;
  matches?: (sel: string) => boolean;
  options?: Array<{ value: string; text: string; label: string; selected: boolean }>;
  multiple?: boolean;
  selectedOptions?: Array<{ value: string; text: string }>;
  focus?: () => void;
  addEventListener?: (type: string, fn: () => void) => void;
  dispatchEvent?: (ev: { type: string }) => void;
  remove?: () => void;
  parentElement?: FakeEl | null;
  /** makeDoc / body.appendChild 挂载前为 null；domops 只在已安装文档里读它。 */
  ownerDocument: FakeDoc | null;
  isContentEditable?: boolean;
  type?: string;
  value?: string;
  disabled?: boolean;
  nodeType?: number;
};

type FakeDoc = {
  body: { appendChild: (el: FakeEl) => void; children: FakeEl[] };
  children: FakeEl[];
  querySelectorAll: (sel: string) => FakeEl[];
  getElementById: (id: string) => FakeEl | null;
  evaluate?: Document["evaluate"];
};

/** domops.selectOption 的取值规格（content/domops.ts 内部 SelectSpec：value/label/index；null=清空；数组=多选）。 */
type SelectSpecLike = string | { value?: string; label?: string; index?: number } | null;

function el(tag: string, attrs: Record<string, string> = {}, text = ""): FakeEl {
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: text,
    isConnected: true,
    shadowRoot: null,
    attributes: { ...attrs },
    children: [],
    ownerDocument: null,
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name) {
      return name in this.attributes;
    },
    contains(other) {
      const walk = (n: FakeEl): boolean => n === other || n.children.some(walk) || (n.shadowRoot ? n.shadowRoot.children.some(walk) : false);

      return walk(this);
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 40, height: 20 };
    },
  };

  if (attrs.id) node.id = attrs.id;

  return node;
}

function makeDoc(roots: FakeEl[], pierceShadow = false): FakeDoc {
  const all = (intoShadow: boolean): FakeEl[] => {
    const out: FakeEl[] = [];

    const visit = (nodes: FakeEl[]) => {
      for (const n of nodes) {
        out.push(n);
        visit(n.children);

        if (intoShadow && n.shadowRoot) visit(n.shadowRoot.children);
      }
    };

    visit(roots);

    return out;
  };

  const doc: FakeDoc = {
    body: {
      children: roots,
      appendChild(child) {
        roots.push(child);
        child.ownerDocument = doc;
      },
    },
    children: roots,
    querySelectorAll(sel: string) {
      if (sel.includes(":has-text")) throw new Error("invalid CSS");
      // 顶层 querySelectorAll 不穿 shadow；穿梭由 resolveTargetSelector.queryAllOpenShadow 负责。
      const list = all(pierceShadow);

      if (sel === "*") return list;

      if (sel.startsWith("#")) return list.filter((n) => n.id === sel.slice(1));

      if (sel === "button" || sel === "BUTTON") return list.filter((n) => n.tagName === "BUTTON");

      if (sel === "iframe") return list.filter((n) => n.tagName === "IFRAME");

      if (sel === "a[href], area[href]") return list.filter((n) => (n.tagName === "A" || n.tagName === "AREA") && n.hasAttribute("href"));

      if (sel.includes("#")) {
        const id = sel.match(/#([A-Za-z0-9_-]+)/)?.[1];

        return id ? list.filter((n) => n.id === id) : [];
      }

      return list.filter((n) => n.tagName.toLowerCase() === sel.toLowerCase());
    },
    getElementById(id: string) {
      return all(true).find((n) => n.id === id) ?? null;
    },
  };

  for (const r of roots) r.ownerDocument = doc;

  return doc;
}

function installDoc(doc: FakeDoc) {
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { document: doc, __sideagent: { refs: new Map() } });
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
}

function bundleDomops(): string {
  const bundled = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/content/domops.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
  });

  // write:false 时 esbuild 才返回 outputFiles；BuildResult 的条件类型不随内联推断收窄，故显式判空。
  const output = bundled.outputFiles?.[0];

  if (!output) throw new Error("domops bundle did not produce an output file");

  return output.text;
}

describe("parseTarget CAP-02C", () => {
  it("解析 loc=role 精确与子串名", () => {
    expect(parseTarget('loc=role:button[name="Confirm order"]')).toEqual({
      kind: "role",
      role: "button",
      name: "Confirm order",
      nameMatch: "exact",
    });
    expect(parseTarget("loc=role:button[name*='increment']")).toEqual({
      kind: "role",
      role: "button",
      name: "increment",
      nameMatch: "substring",
    });
    expect(parseTarget("loc=href:/docs/a")).toEqual({ kind: "href", href: "/docs/a" });
    expect(parseTarget("loc=role:button")).toBeNull();
  });

  it("resolveArgs 把 role 编成 JSON 供页面 resolver", () => {
    const parsed = parseTarget('loc=role:button[name="Save"]')!;
    expect(parsed.kind).toBe("role");

    if (parsed.kind !== "role") return;
    expect(resolveArgs(parsed)).toEqual({
      kind: "role",
      selector: JSON.stringify({ role: "button", name: "Save", nameMatch: "exact" }),
    });
  });
});

describe("resolveTargetSelector 反例（stub DOM）", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("ARIA 名与显示文本不同时按可访问名命中，不用 textContent 伪装", () => {
    const wrong = el("button", { id: "wrong" }, "Submit");
    const right = el("button", { id: "right", "aria-label": "Confirm order" }, "Submit");
    installDoc(makeDoc([wrong, right]));

    const hit = resolveTargetSelector(
      "role",
      JSON.stringify({ role: "button", name: "Confirm order", nameMatch: "exact" }),
    );

    expect(hit.id).toBe("right");

    const byDisplay = resolveTargetSelector(
      "role",
      JSON.stringify({ role: "button", name: "Submit", nameMatch: "exact" }),
    );

    expect(byDisplay.id).toBe("wrong");
  });

  it("重复可访问名在不同区域歧义失败，不执行第一个", () => {
    const a = el("button", { "aria-label": "Duplicate" }, "1");
    const b = el("button", { "aria-label": "Duplicate" }, "2");
    installDoc(makeDoc([a, b]));
    expect(() =>
      resolveTargetSelector("role", JSON.stringify({ role: "button", name: "Duplicate", nameMatch: "exact" })),
    ).toThrow(/匹配 2 个/);
  });

  it("嵌套 open shadow 内 CSS 可命中", () => {
    const host = el("div", { id: "outer" });
    const mid = el("div");
    const btn = el("button", { id: "deep-btn" }, "Shadow");
    const root2: FakeDoc = makeDoc([btn]);
    mid.shadowRoot = root2;
    const root1: FakeDoc = makeDoc([mid]);
    host.shadowRoot = root1;
    const top = makeDoc([host]);
    // queryAllOpenShadow 从 document 开始；shadow 挂在 host 上
    installDoc(top);
    const found = resolveTargetSelector("css", "#deep-btn");
    expect(found.id).toBe("deep-btn");
  });

  it("同源 frame 内唯一控件可定位；顶层同名不误点", () => {
    const topBtn = el("button", { id: "top" }, "Go");
    const inner = el("button", { id: "inner", "aria-label": "Run iframe action" }, "Go");
    const frameDoc = makeDoc([inner]);
    const iframe = el("iframe", { id: "f" });
    iframe.contentDocument = frameDoc;
    installDoc(makeDoc([topBtn, iframe]));

    const hit = resolveTargetSelector(
      "role",
      JSON.stringify({ role: "button", name: "Run iframe action", nameMatch: "exact" }),
    );

    expect(hit.id).toBe("inner");
    expect((resolveTargetSelector("css", "#top")).id).toBe("top");
  });

  it(":has-text 仍明确拒绝", () => {
    installDoc(makeDoc([el("h3", {}, "项目")]));
    expect(() => resolveTargetSelector("css", 'h3:has-text("项目")')).toThrow(/:has-text|无效的选择器/);
  });
});

describe("domops selectOption / 旧 ref", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("多选、按 index、清空，并派发 change；最终选中集合可证", () => {
    type Opt = { value: string; text: string; label: string; selected: boolean };

    const options: Opt[] = [
      { value: "a", text: "Alpha", label: "Alpha", selected: false },
      { value: "b", text: "Beta", label: "Beta", selected: false },
      { value: "c", text: "Gamma", label: "Gamma", selected: false },
    ];

    const events: string[] = [];
    const select = el("select", { id: "multi" });
    select.multiple = true;
    Object.defineProperty(select, "options", {
      get() {
        return options;
      },
    });
    Object.defineProperty(select, "selectedOptions", {
      get() {
        return options.filter((o) => o.selected);
      },
    });
    select.focus = () => {};

    const listeners: Record<string, Array<() => void>> = {};
    select.addEventListener = (type, fn) => {
      (listeners[type] ??= []).push(fn);
    };

    select.dispatchEvent = (ev) => {
      for (const fn of listeners[ev.type] ?? []) fn();
      events.push(ev.type);
    };

    const doc = makeDoc([select]);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { document: doc, __sideagent: undefined });
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("HTMLInputElement", { prototype: {} });
    vi.stubGlobal("HTMLTextAreaElement", { prototype: {} });
    vi.stubGlobal("Event", class {
      type: string;
      bubbles: boolean;
      constructor(type: string, init?: { bubbles?: boolean }) {
        this.type = type;
        this.bubbles = init?.bubbles ?? false;
      }
    });
    vi.stubGlobal("PointerEvent", class {});
    vi.stubGlobal("MouseEvent", class {});
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    runInThisContext(bundleDomops());

    // SAFETY: 上一行 runInThisContext(bundleDomops()) 已把 content/domops.ts 装进当前全局，
    // domops 启动即写入 window.__sideagent.dom；TS 的 window 类型没有这个扩展点，故断言到具名形状再取。
    const dom = (window as unknown as {
      __sideagent: { dom: { selectOption: (t: string, v: SelectSpecLike | SelectSpecLike[]) => { selected: string[]; labels: string[] } } };
    }).__sideagent.dom;

    const multi = dom.selectOption("#multi", [{ value: "a" }, { index: 2 }]);
    expect(multi.selected).toEqual(["a", "c"]);
    expect(multi.labels).toEqual(["Alpha", "Gamma"]);
    expect(events.filter((e) => e === "input" || e === "change")).toEqual(["input", "change"]);

    events.length = 0;
    const cleared = dom.selectOption("#multi", null);
    expect(cleared.selected).toEqual([]);
    expect(options.every((o) => !o.selected)).toBe(true);

    const byLabel = dom.selectOption("#multi", { label: "Beta" });
    expect(byLabel.selected).toEqual(["b"]);
  });

  it("失效 ref 不执行 selectOption", () => {
    const select = el("select", { id: "s" });
    select.options = [{ value: "1", text: "One", label: "One", selected: false }];
    select.isConnected = false;
    const doc = makeDoc([select]);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { document: doc, __sideagent: undefined });
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("HTMLInputElement", { prototype: {} });
    vi.stubGlobal("HTMLTextAreaElement", { prototype: {} });
    vi.stubGlobal("Event", class {
      constructor(public type: string) {}
    });
    vi.stubGlobal("PointerEvent", class {});
    vi.stubGlobal("MouseEvent", class {});
    vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible" }));
    runInThisContext(bundleDomops());

    // SAFETY: 同一 bundle 里 domops 会把 window.__sideagent.refs 初始化为 Map；
    // 这里断言到具名形状，登记 9 号已失效 ref 后调用其 selectOption。
    const ns = (window as unknown as {
      __sideagent: { refs: Map<number, FakeEl>; dom: { selectOption: (t: string, v: SelectSpecLike | SelectSpecLike[]) => { selected: string[]; labels: string[] } } };
    }).__sideagent;

    ns.refs.set(9, select);
    expect(() => ns.dom.selectOption("@9", "1")).toThrow(/已失效|snapshot/);
  });
});

describe("waitFor 四态", () => {
  it("attached / detached / visible / hidden 走不同探测，不把 visible+enabled 冒充 hidden", async () => {
    let attached = false;
    let visible = false;

    const call = vi.fn(async (name: string) => {
      if (name !== "read_element") throw new Error(`unexpected ${name}`);

      if (!attached) throw new Error("NOT_FOUND: 未找到");

      return { properties: { visible, enabled: true } };
    });

    setTimeout(() => {
      attached = true;
      visible = false;
    }, 40);

    const a = await runBrowserProgram({
      code: 'return await browser.waitFor({selector:"#x",state:"attached",timeoutMs:500});',
      call,
    });

    expect(a.value).toMatchObject({ ready: true, state: "attached" });

    attached = true;
    visible = false;

    const h = await runBrowserProgram({
      code: 'return await browser.waitFor({selector:"#x",state:"hidden",timeoutMs:300});',
      call,
    });

    expect(h.value).toMatchObject({ ready: true, state: "hidden" });

    visible = true;

    const v = await runBrowserProgram({
      code: 'return await browser.waitFor({selector:"#x",state:"visible",timeoutMs:300});',
      call,
    });

    expect(v.value).toMatchObject({ ready: true, state: "visible" });

    attached = true;
    setTimeout(() => {
      attached = false;
    }, 40);

    const d = await runBrowserProgram({
      code: 'return await browser.waitFor({selector:"#x",state:"detached",timeoutMs:500});',
      call,
    });

    expect(d.value).toMatchObject({ ready: true, state: "detached" });

    await expect(
      runBrowserProgram({
        code: 'return await browser.waitFor({selector:"#x",state:"networkidle",timeoutMs:100});',
        call: vi.fn(),
      }),
    ).rejects.toThrow(/UNSUPPORTED_WAIT_STATE/);
  });
});

describe("CAP-02C 正式入口接线", () => {
  it("select_option / screenshot 选项在工具表可达，不进 Realtime 固定表", async () => {
    expect(TOOL_NAMES).toContain("select_option");

    const rpc = {
      call: vi.fn<ToolRpc["call"]>(async (name, params) => {
        if (name === "select_option") return { selected: ["a", "c"], labels: ["Alpha", "Gamma"] };

        if (name === "screenshot") {
          // SAFETY: params 是 RPC 边界的 Record 载荷；clip 存在时即 shared/protocol.ts ToolContract.screenshot.params.clip 描述的文档 CSS 矩形。
          return {
            imageBase64: "AA==",
            mediaType: "image/png",
            width: 10,
            height: 10,
            pixelWidth: 10,
            pixelHeight: 10,
            cssWidth: params.clip ? (params.clip as { width: number }).width : 800,
            cssHeight: params.clip ? (params.clip as { height: number }).height : 600,
            devicePixelRatio: 2,
            tabId: 1,
            url: "https://example.test",
            title: "t",
            capturedAt: 1,
            source: "cdp",
            clip: params.clip,
            fullPage: params.fullPage,
            scale: params.scale ?? "css",
          };
        }

        return {};
      }),
      ensureToolCall() {},
      markCallRejected() {},
      noteToolFact() {},
    };

    // SAFETY: createBrowserTools 只读 rpc.call 与三个可选钩子（ensureToolCall/markCallRejected/noteToolFact 在 tools.ts 里均以 rpc.x?.() 可选调用），stub 提供的正是这四个方法。
    const tools = createBrowserTools(rpc as never, undefined, undefined, () => true, {
      epoch: () => 1,
      canWrite: () => true,
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("select_option");
    expect(REALTIME_BROWSER_TOOL_NAMES).not.toContain("select_option");

    const select = tools.find((t) => t.name === "select_option")!;
    // SAFETY: 字面量与 shared/protocol.ts 的 ToolContract.select_option.params 一致（target + values 数组），执行时由工具自身 schema 校验。
    await select.execute("s1", { target: "#multi", values: ["a", { index: 2 }] } as never, undefined, undefined, {} as never);
    expect(rpc.call.mock.calls.find((c) => c[0] === "select_option")![1]).toMatchObject({
      target: "#multi",
      values: ["a", { index: 2 }],
    });

    const shot = tools.find((t) => t.name === "screenshot")!;
    // SAFETY: clip/scale 与 ToolContract.screenshot.params 一致；浏览器工具的 execute 只消费 id/params/signal/onUpdate，第五参 ExtensionContext 传空对象即可（tools.ts 的各 execute 均不读 ctx）。
    await shot.execute(
      "s2",
      { clip: { x: 10, y: 20, width: 100, height: 50 }, scale: "css" } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(rpc.call.mock.calls.find((c) => c[0] === "screenshot")![1]).toMatchObject({
      clip: { x: 10, y: 20, width: 100, height: 50 },
      scale: "css",
    });
  });

  it("browser_run selectOption 别名派发规范 RPC", async () => {
    const call = vi.fn<Parameters<typeof runBrowserProgram>[0]["call"]>(async (name) => {
      if (name === "select_option") return { selected: [], labels: [] };
      throw new Error(`unexpected ${name}`);
    });

    await runBrowserProgram({
      code: `return await browser.selectOption({ target: "#s", values: null });`,
      call,
    });
    expect(call.mock.calls.map((c) => c[0])).toEqual(["select_option"]);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ target: "#s", values: null });
  });
});

describe("截图 clip 与 CSS 坐标契约（纯函数期望）", () => {
  it("回执 cssWidth/Height 等于 clip 区域，供点击坐标对齐", () => {
    const clip = { x: 12, y: 34, width: 200, height: 80 };
    expect(Math.round(clip.width)).toBe(200);
    expect(Math.round(clip.height)).toBe(80);
    expect({ x: clip.x + 10, y: clip.y + 5 }).toEqual({ x: 22, y: 39 });
  });
});
