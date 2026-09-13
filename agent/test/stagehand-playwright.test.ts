/**
 * api:'playwright'（Stagehand 官方 Playwright 兼容层）回归。
 *
 * 证据边界：QuickJS 沙箱、vendored 官方 runtime 源码、browser RPC 顺序与参数、控制/取消闸门
 * 都是真的；「页面」是本地合成 DOM（node:vm + 微型 DOM），所以这里证明的是兼容层→RPC 接线、
 * 定位计划、写入目标与停止语义。真实 Chrome 页面由 scripts/acceptance/stagehand-control.mts 验收。
 */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../src/tools.js";
import { ToolRpc } from "../src/rpc.js";
import { runBrowserProgram, type ProgramStep } from "../src/browser-program.js";
import { stagehandRuntimeSource } from "../src/stagehand-bridge.js";

// ── 合成页面（只实现官方兼容层查询引擎真正用到的 DOM 面） ──────────────

class Dummy {}

interface Spec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: Spec[];
  value?: string;
}

class FakeElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly ownText: string;
  readonly kids: FakeElement[];
  value: string;
  parent: FakeElement | null = null;
  clicks = 0;

  constructor(spec: Spec, private readonly doc: FakeDocument) {
    this.tag = spec.tag.toLowerCase();
    this.attrs = { ...(spec.attrs ?? {}) };
    this.ownText = spec.text ?? "";
    this.value = spec.value ?? "";
    this.kids = (spec.children ?? []).map(child => {
      const element = new FakeElement(child, doc);
      element.parent = this;
      return element;
    });
  }

  get tagName(): string { return this.tag.toUpperCase(); }
  get children(): FakeElement[] { return this.kids; }
  get textContent(): string { return this.ownText + this.kids.map(kid => kid.textContent).join(""); }
  get id(): string { return this.attrs.id ?? ""; }
  get isConnected(): boolean { return true; }
  get shadowRoot(): null { return null; }
  get parentElement(): FakeElement | null { return this.parent; }
  get ownerDocument(): FakeDocument { return this.doc; }
  get labels(): FakeElement[] {
    return this.doc.all().filter(element =>
      element.tag === "label" &&
      (element.attrs.for === this.id || (this.id === "" && element.kids.includes(this))));
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attrs; }
  setAttribute(name: string, value: string): void { this.attrs[name] = String(value); }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  matches(selector: string): boolean { return this.doc.querySelectorAll(selector).includes(this); }
  getBoundingClientRect() { return { x: 10, y: 20, width: 120, height: 24, top: 20, left: 10, right: 130, bottom: 44 }; }
  getComputedStyle() { return this.attrs["data-hidden"] === "true" ? { visibility: "hidden", display: "none" } : { visibility: "visible", display: "block" }; }
  scrollIntoView(): void { /* 合成页面没有布局 */ }
  focus(): void { this.doc.focus = this; }
  blur(): void { if (this.doc.focus === this) this.doc.focus = null; }
  click(): void { this.clicks += 1; }
  querySelectorAll(selector: string): FakeElement[] { return this.doc.matchesUnder(this, selector); }
}

class FakeDocument {
  readonly root: FakeElement;
  focus: FakeElement | null = null;

  constructor(readonly spec: Spec) {
    this.root = new FakeElement(spec, this);
    this.root.parent = null;
  }

  all(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (element: FakeElement) => { for (const kid of element.kids) { out.push(kid); walk(kid); } };
    walk(this.root);
    return out;
  }

  matchesUnder(host: FakeElement, selector: string): FakeElement[] {
    const pool = host === this.root ? this.all() : under(host);
    return pool.filter(element => testSelector(element, selector));
  }

  querySelectorAll(selector: string): FakeElement[] { return this.matchesUnder(this.root, selector); }
  getElementById(id: string): FakeElement | null { return this.all().find(element => element.id === id) ?? null; }
  get documentElement(): FakeElement { return this.root; }
}

function under(host: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (element: FakeElement) => { for (const kid of element.kids) { out.push(kid); walk(kid); } };
  walk(host);
  return out;
}

function testSelector(element: FakeElement, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed === "*") return true;
  const attribute = /^\[([\w-]+)(?:([~|^$*]?=)"(.*)")?\]$/u.exec(trimmed);
  if (attribute) {
    const value = element.getAttribute(attribute[1]!);
    if (value === null) return false;
    if (attribute[3] === undefined) return true;
    if (attribute[2] === "=") return value === attribute[3];
    return false;
  }
  if (trimmed.startsWith("#")) return element.id === trimmed.slice(1);
  return element.tag === trimmed.toLowerCase();
}

/** 一次页面会话：微型 DOM + 记录动作的假扩展。extra 用于补多匹配等场景。 */
function createPage(extra: Spec[] = []) {
  const document = new FakeDocument({
    tag: "body",
    children: [
      { tag: "h1", text: "填写联系信息" },
      { tag: "label", attrs: { for: "name" }, text: "姓名" },
      { tag: "input", attrs: { id: "name" }, value: "" },
      { tag: "label", attrs: { for: "email" }, text: "邮箱" },
      { tag: "input", attrs: { id: "email", type: "email" }, value: "" },
      { tag: "button", attrs: { id: "submit" }, text: "提交" },
      { tag: "div", attrs: { id: "status", "data-hidden": "true" }, text: "隐藏提示" },
      ...extra,
    ],
  });
  const calls: Array<{ name: string; params: Record<string, unknown>; resolvedId?: string }> = [];
  const sandbox = {
    document,
    location: { href: "https://work.example/contact" },
    innerWidth: 1280, innerHeight: 720,
    window: { getSelection: () => null },
    getComputedStyle: (element: FakeElement) => element.getComputedStyle(),
    Element: Dummy, HTMLInputElement: Dummy, HTMLImageElement: Dummy, HTMLOptionElement: Dummy,
    CSS: { escape: (value: string) => value.replace(/["\\]/gu, "\\$&") },
    XPathResult: {}, console: { log: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const context = createContext(sandbox);
  const runPage = async (code: string): Promise<unknown> => {
    // 页面侧表达式（官方 runtime 生成）在隔离 context 里真求值；Node 宿主不受影响。
    const produced = await runInContext(`(async () => { return (${code}); })()`, context) as unknown;
    return JSON.parse(JSON.stringify(produced ?? null)) as unknown;
  };
  const element = (target: unknown): FakeElement => {
    const matches = document.querySelectorAll(String(target));
    if (matches.length === 0) throw new Error(`未找到目标元素：${String(target)}`);
    if (matches.length > 1) throw new Error(`CSS 选择器匹配 ${matches.length} 个元素`);
    return matches[0]!;
  };
  const extension = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
    if (name === "list_tabs") {
      calls.push({ name, params });
      return { tabs: [{ id: 12, title: "contact", url: "https://work.example/contact", active: false, windowId: 1, working: true }] };
    }
    if (name === "js") {
      calls.push({ name, params });
      return { value: await runPage(String(params.code)) };
    }
    const target = params.target === undefined ? undefined : element(params.target);
    const resolvedId = target?.id;
    calls.push({ name, params, ...(resolvedId === undefined ? {} : { resolvedId }) });
    if (name === "fill") {
      if (!target) throw new Error("fill 需要目标");
      target.value = String(params.value);
      return { filled: true };
    }
    if (name === "click") {
      if (target) target.click();
      return { clicked: true };
    }
    if (name === "hover") return { hovered: true };
    if (name === "press_key") return { pressed: true };
    if (name === "type_text") {
      (document.focus ?? target)!.value += String(params.text);
      return { typed: true };
    }
    throw new Error(`假扩展没有实现 ${name}`);
  };
  const value = (id: string): string => document.getElementById(id)?.value ?? "";
  return { document, calls, runPage, extension, value };
}

// ── 用例 ──────────────────────────────────────────────────────────────

describe("browser_run api:'playwright'", () => {
  it("runs the vendored official runtime and writes through the real fill RPC", async () => {
    const page = createPage();
    const result = await runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "await page.getByLabel('姓名',{exact:true}).fill('张三'); return {name: await page.locator('#name').inputValue(), email: await page.locator('#email').inputValue()};",
      call: (name, params) => page.extension(name, params),
    });
    expect(result.value).toEqual({ name: "张三", email: "" });
    expect(page.value("name")).toBe("张三");
    expect(page.value("email")).toBe("");
    // 绑定页只读一次：程序第一步就是 list_tabs。
    expect(page.calls[0]!.name).toBe("list_tabs");
    const fills = page.calls.filter(call => call.name === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0]!.params.value).toBe("张三");
    expect(fills[0]!.resolvedId).toBe("name");
    // 官方兼容层自己打了数据标记，再把这个标记交给真实 fill RPC。
    expect(String(fills[0]!.params.target)).toMatch(/^\[data-stagehand-pw-compat="[0-9a-f-]{36}"\]$/u);
    // 定位计划来自官方查询引擎：getByLabel → {kind:'label', matcher:{...exact}}。
    const plans = page.calls.filter(call => call.name === "js").map(call => String(call.params.code));
    expect(plans.some(code => code.includes('{"kind":"label","matcher":{"kind":"string","value":"姓名","exact":true}}'))).toBe(true);
    // 没有走浏览器 active 页，也没有绕过 RPC 直接写值。
    expect(page.calls.every(call => call.name === "list_tabs" || call.params.tabId === 12)).toBe(true);
  });

  it("resolves getByRole for both a labelled textbox and a named button", async () => {
    const page = createPage();
    const result = await runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "await page.getByRole('textbox',{name:'邮箱',exact:true}).fill('a@b.c'); await page.getByRole('button',{name:'提交',exact:true}).press('Enter'); return {email: await page.locator('#email').inputValue(), submitClicks: await page.evaluate(() => 0)};",
      call: (name, params) => page.extension(name, params),
    });
    expect((result.value as { email: string }).email).toBe("a@b.c");
    expect(page.value("email")).toBe("a@b.c");
    const fill = page.calls.find(call => call.name === "fill")!;
    expect(fill.resolvedId).toBe("email");
    const click = page.calls.find(call => call.name === "click")!;
    expect(click.resolvedId).toBe("submit");
    expect(page.calls.find(call => call.name === "press_key")!.params.key).toBe("Enter");
    const plans = page.calls.filter(call => call.name === "js").map(call => String(call.params.code));
    expect(plans.some(code => code.includes('"role":"textbox"'))).toBe(true);
    expect(plans.some(code => code.includes('"role":"button"'))).toBe(true);
  });

  it("keeps every action on the task page even when the browser active tab is elsewhere", async () => {
    const page = createPage();
    // list_tabs 报的 working 页是 99（模拟用户此刻看着别的页），工具缺省页是 12。
    const extension = async (name: string, params: Record<string, unknown>) => {
      if (name === "list_tabs") {
        page.calls.push({ name, params });
        return { tabs: [
          { id: 12, title: "contact", url: "https://work.example/contact", active: false, windowId: 1, working: false },
          { id: 99, title: "other", url: "https://work.example/other", active: true, windowId: 1, working: true },
        ] };
      }
      return page.extension(name, params);
    };
    await runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "await page.getByLabel('姓名',{exact:true}).fill('绑定页'); return null;",
      call: (name, params) => extension(name, params),
    });
    const writes = page.calls.filter(call => call.name !== "list_tabs");
    expect(writes.length).toBeGreaterThan(3);
    expect(writes.every(call => call.params.tabId === 12)).toBe(true);
    expect(page.calls.some(call => call.params.tabId === 99)).toBe(false);
    expect(page.value("name")).toBe("绑定页");

    // 没有工具缺省页时，用 list_tabs 的 working 页；结果同样是固定值。
    const second = createPage();
    await runBrowserProgram({
      api: "playwright", pageTabId: null,
      code: "await page.getByLabel('姓名',{exact:true}).fill('工作页'); return null;",
      call: (name, params) => second.extension(name, params),
    });
    expect(second.calls.filter(call => call.name !== "list_tabs").every(call => call.params.tabId === 12)).toBe(true);
  });

  it("refuses to run playwright mode without any bound task page", async () => {
    const page = createPage();
    const listOnly = async (name: string, params: Record<string, unknown>) => {
      if (name === "list_tabs") return { tabs: [{ id: 99, title: "other", url: "https://x/", active: true, windowId: 1, working: false }] };
      return page.extension(name, params);
    };
    await expect(runBrowserProgram({
      api: "playwright", pageTabId: null,
      code: "await page.getByLabel('姓名').fill('x'); return null;",
      call: (name, params) => listOnly(name, params),
    })).rejects.toThrow(/没有绑定的任务页面/u);
    expect(page.calls.filter(call => call.name === "fill")).toHaveLength(0);
  });

  it("reports the official strict-mode violation instead of picking one of two matches", async () => {
    const page = createPage([
      { tag: "label", attrs: { for: "name2" }, text: "姓名" },
      { tag: "input", attrs: { id: "name2" }, value: "" },
    ]);
    await expect(runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "await page.getByLabel('姓名',{exact:true}).fill('x'); return null;",
      call: (name, params) => page.extension(name, params),
    })).rejects.toThrow(/strict mode violation: 2 elements matched/u);
    expect(page.calls.filter(call => call.name === "fill")).toHaveLength(0);
    expect(page.value("name")).toBe("");
    expect(page.value("name2")).toBe("");
  });

  it("keeps host capabilities out of the sandbox in playwright mode", async () => {
    const page = createPage();
    const result = await runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "return [typeof process, typeof require, typeof fetch, typeof document, typeof __browserCall].join(',');",
      call: (name, params) => page.extension(name, params),
    });
    expect(result.value).toBe("undefined,undefined,undefined,undefined,undefined");
  });

  it("fails loudly on unsupported Playwright surface instead of pretending", async () => {
    const cases: Array<[string, RegExp]> = [
      ["await page.goto('https://work.example/next'); return 'ok';", /page\.goto 未接入/u],
      ["await page.waitForSelector('#name'); return 'ok';", /waitForSelector 未接入/u],
      ["await page.screenshot(); return 'ok';", /RawPage\.screenshot 未接入/u],
      ["await page.request.get('https://work.example/api'); return 'ok';", /playwright 的 request API 未接入/u],
      ["await context.request.fetch('https://work.example/api'); return 'ok';", /playwright 的 request API 未接入/u],
      // 别名：官方 facade 的 page.context()/context.pages() 必须回到同一批守卫对象。
      ["await page.context().request.get('https://work.example/api'); return 'ok';", /playwright 的 request API 未接入/u],
      ["await page.context().waitForEvent('page'); return 'ok';", /context\.waitForEvent 未接入/u],
      ["await context.pages()[0].request.fetch('https://work.example/api'); return 'ok';", /playwright 的 request API 未接入/u],
      ["await context.newPage(); return 'ok';", /context\.newPage 未接入/u],
      ["await page.locator('#name').selectOption('x'); return 'ok';", /selectOption 未接入/u],
      ["await page.locator('#name').type('x'); return 'ok';", /locator\.type\/pressSequentially 未接入/u],
      ["await page.getByRole('button',{name:'提交'}).click({button:'right'}); return 'ok';", /只支持左键/u],
      ["await page.mouse.click(5,5,{clickCount:2}); return 'ok';", /只支持单击/u],
      // 上游会把 trial/position/force 静默丢掉（trial:true 仍会真点），ego 在丢弃前拒绝。
      ["await page.getByRole('button',{name:'提交'}).click({trial:true}); return 'ok';", /locator\.click option\(s\) not supported by ego: trial/u],
      ["await page.getByRole('button',{name:'提交'}).click({position:{x:1,y:2}}); return 'ok';", /locator\.click option\(s\) not supported by ego: position/u],
      ["await page.getByRole('button',{name:'提交'}).click({force:true}); return 'ok';", /locator\.click option\(s\) not supported by ego: force/u],
      ["await page.getByLabel('姓名',{exact:true}).fill('x',{trial:true}); return 'ok';", /locator\.fill option\(s\) not supported by ego: trial/u],
      ["await page.on('console',()=>{}); return 'ok';", /page\.on 未接入/u],
      ["await context.waitForEvent('page'); return 'ok';", /context\.waitForEvent 未接入/u],
    ];
    for (const [code, expected] of cases) {
      const page = createPage();
      await expect(runBrowserProgram({ api: "playwright", pageTabId: 12, code, call: (name, params) => page.extension(name, params) }))
        .rejects.toThrow(expected);
      // 拒绝要发生在真实写入之前：没有任何 fill/click/press RPC 被派发。
      expect(page.calls.filter(call => ["fill", "click", "press_key", "type_text"].includes(call.name))).toHaveLength(0);
      // 也不允许经页面内 domClick、或经 request 回退到页面 fetch。
      const pageCode = page.calls.filter(call => call.name === "js").map(call => String(call.params.code)).join("\n");
      expect(pageCode).not.toContain('"operation":"domClick"');
      expect(pageCode).not.toContain("fetch(");
    }
    // press 的 delay 选项：官方兼容层先点目标再发按键，所以点击本身会派发；
    // 桥不吞掉 delay，按键不派发，错误里说清未接入。
    const delayed = createPage();
    await expect(runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "await page.getByRole('button',{name:'提交'}).press('Enter',{delay:50}); return 'ok';",
      call: (name, params) => delayed.extension(name, params),
    })).rejects.toThrow(/press 的 delay 未接入/u);
    expect(delayed.calls.filter(call => call.name === "press_key")).toHaveLength(0);
  });

  it("initializes the full vendored runtime inside the QuickJS sandbox limits", async () => {
    const source = stagehandRuntimeSource();
    // 官方自包含 runtime 的实参：源码随 QuickJS 程序一起解析，不是本地重写的兼容层。
    expect(source.length).toBeGreaterThan(40_000);
    expect(source).toContain("async function createPlaywrightCompatRuntime");
    expect(source).toContain("executeQueryInPage");
    expect(source).toContain("data-stagehand-pw-compat");
    const page = createPage();
    const result = await runBrowserProgram({
      api: "playwright", pageTabId: 12,
      code: "const a = await page.getByLabel('姓名',{exact:true}).isVisible(); const b = await page.getByRole('button',{name:'提交'}).count(); return {a,b};",
      call: (name, params) => page.extension(name, params),
    });
    expect(result.value).toEqual({ a: true, b: 1 });
  });

  it("keeps ego mode unchanged: no page/context without api", async () => {
    const page = createPage();
    const result = await runBrowserProgram({
      code: "return [typeof page, typeof context].join(',');",
      call: (name, params) => page.extension(name, params),
    });
    expect(result.value).toBe("undefined,undefined");
    expect(page.calls).toHaveLength(0);
  });
});

describe("browser_run api:'playwright' 控制闸门", () => {
  function harness(api: "playwright" | "ego" = "playwright", observe: (step: ProgramStep) => void = () => {}, enabled: (name: string) => boolean = () => true, hidden: (name: string) => boolean = () => false) {
    const page = createPage();
    const frames: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
    let epoch = 0;
    let workingTab = 12;
    const steps: ProgramStep[] = [];
    const rpc = new ToolRpc(frame => {
      frames.push({ id: frame.id, name: frame.name, params: frame.params });
      // 绑定页在程序第一步读一次；之后用户切到别的页也不该改变这个值。
      const listing = { tabs: [
        { id: 12, title: "contact", url: "https://work.example/contact", active: workingTab !== 12, windowId: 1, working: workingTab === 12 },
        { id: 99, title: "other", url: "https://work.example/other", active: workingTab === 99, windowId: 1, working: workingTab === 99 },
      ] };
      const answered = frame.name === "list_tabs"
        ? Promise.resolve(listing)
        : page.extension(frame.name, frame.params);
      void answered.then(
        data => rpc.handleResult(frame.id, true, data),
        error => rpc.handleResult(frame.id, false, undefined, String(error)),
      );
    });
    rpc.setPageTarget(undefined, 12);
    const tool = createBrowserTools(rpc, undefined, undefined, enabled, {
      isToolHiddenByMode: hidden, epoch: () => epoch, canWrite: () => true, onStep: step => { steps.push(step); observe(step); },
    }).find(candidate => candidate.name === "browser_run")!;
    const run = (code: string, signal?: AbortSignal) =>
      tool.execute("accept", { code, api }, signal, undefined, {} as never);
    return {
      page, frames, steps, run,
      bumpEpoch: () => { epoch += 1; },
      switchUserTab: (tabId: number) => { workingTab = tabId; },
    };
  }

  it("runs in the production solo surface while still respecting disabled primitive writes", async () => {
    const solo = harness("playwright", () => {}, name => name !== "page_operation", name => name === "page_operation");
    await solo.run("await page.getByLabel('姓名',{exact:true}).fill('李明');");
    expect(solo.page.value("name")).toBe("李明");
    const restricted = harness("playwright", () => {}, name => !["page_operation", "fill"].includes(name), name => name === "page_operation");
    await expect(restricted.run("await page.getByLabel('姓名',{exact:true}).fill('NO');")).rejects.toThrow(/fill/);
    expect(restricted.page.calls.filter(call => call.name === "fill")).toHaveLength(0);
  });

  it("stops a running program on abort, including a caught waitForTimeout", async () => {
    const controller = new AbortController();
    let before = 0;
    const harnessed = harness("playwright", step => {
      if (step.name === "sleep" && step.phase === "start") { before = harnessed.frames.length; controller.abort(); }
    });
    const promise = harnessed.run(
      "try { await page.waitForTimeout(1500); } catch {} await page.getByLabel('姓名',{exact:true}).fill('SHOULD_NOT_WRITE'); return 'done';",
      controller.signal,
    );
    await expect(promise).rejects.toThrow(/abort|中止/u);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(harnessed.frames.length).toBe(before);
    expect(harnessed.page.value("name")).toBe("");
    expect(harnessed.page.calls.filter(call => call.name === "fill")).toHaveLength(0);
    // waitForTimeout 走的是 browser.sleep，因此中止点能落在等待步骤上。
    expect(harnessed.steps.some(step => step.name === "sleep" && step.phase === "start")).toBe(true);
  });

  it("refuses later writes when the task epoch changes mid-program", async () => {
    const harnessed = harness("playwright", step => { if (step.name === "sleep" && step.phase === "start") harnessed.bumpEpoch(); });
    const promise = harnessed.run("await page.waitForTimeout(300); await page.getByLabel('姓名',{exact:true}).fill('STALE'); return 'done';");
    await expect(promise).rejects.toThrow(/改变|旧步骤|未执行/u);
    expect(harnessed.page.value("name")).toBe("");
    expect(harnessed.page.calls.filter(call => call.name === "fill")).toHaveLength(0);
  });

  it("does not let a caught held click continue the program", async () => {
    const page = createPage();
    const rpc = new ToolRpc(frame => {
      if (frame.name === "list_tabs") { queueMicrotask(() => rpc.handleResult(frame.id, true, { tabs: [{ id: 12, working: true, active: true, windowId: 1, title: "t", url: "https://x/" }] })); return; }
      if (frame.name === "click") { queueMicrotask(() => rpc.handleResult(frame.id, true, { clicked: false, held: true })); return; }
      void page.extension(frame.name, frame.params).then(
        data => rpc.handleResult(frame.id, true, data),
        error => rpc.handleResult(frame.id, false, undefined, String(error)),
      );
    });
    rpc.setPageTarget(undefined, 12);
    const tool = createBrowserTools(rpc, undefined, undefined, () => true, { epoch: () => 0, canWrite: () => true })
      .find(candidate => candidate.name === "browser_run")!;
    await expect(tool.execute("accept", {
      api: "playwright",
      code: "try { await page.getByRole('button',{name:'提交'}).click(); } catch {} await page.getByLabel('姓名',{exact:true}).fill('SHOULD_NOT_WRITE'); return 'done';",
    }, undefined, undefined, {} as never)).rejects.toThrow(/held|等待用户确认/iu);
    expect(page.calls.filter(call => call.name === "fill")).toHaveLength(0);
  });

  it("keeps the pinned tab when the user switches the active tab mid-program", async () => {
    const harnessed = harness("playwright", step => { if (step.name === "sleep" && step.phase === "start") harnessed.switchUserTab(99); });
    const promise = harnessed.run(
      "await page.waitForTimeout(50); await page.getByLabel('姓名',{exact:true}).fill('李明'); return await page.locator('#name').inputValue();",
    );
    // 用户程序等在 sleep 上时，用户把活动页切到 99（working 也跟着变）；绑定值必须仍是 12。
    const result = await promise as { details: { value: unknown } };
    expect(result.details.value).toBe("李明");
    const writes = harnessed.page.calls.filter(call => ["fill", "click"].includes(call.name));
    expect(writes.every(call => call.params.tabId === 12)).toBe(true);
    expect(harnessed.page.value("name")).toBe("李明");
  });
});
