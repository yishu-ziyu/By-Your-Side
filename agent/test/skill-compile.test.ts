import { describe, expect, it } from "vitest";
import { compileSkill, validateCompiledSkill } from "../src/skill-compile.js";
import { runBrowserProgram } from "../src/browser-program.js";
import { forbiddenInSkill, normalizeSkillHost, skillHealth, skillRunSummary, skillStepsText } from "../../shared/skill.js";
import type { DemoStep } from "../../shared/demo-record.js";

const demo: DemoStep[] = [
  { at: 0, kind: "click", anchor: { tag: "button", name: "筛选" } },
  { at: 120, kind: "click", anchor: { tag: "input", inputType: "search", name: "客户名" } },
  { at: 200, kind: "type", anchor: { tag: "input", inputType: "search", name: "客户名" }, value: "张三" },
  { at: 300, kind: "press", key: "Enter" },
  { at: 900, kind: "click", anchor: { tag: "a", name: "第一条记录" } },
  { at: 1500, kind: "type", anchor: { tag: "input", name: "备注" }, value: "示范备注" },
  { at: 1600, kind: "type", anchor: { tag: "input", name: "密码" }, redacted: true },
  { at: 1700, kind: "click", anchor: { tag: "button", name: "保存" } },
  { at: 1750, kind: "submit" },
];

const base = { id: "skill-1", demoId: "demo-1", intent: "把未跟进的客户整理出来", hostname: "www.Example.com", steps: demo, now: 1_700_000_000_000 };

describe("编译示范", () => {
  it("生成人话步骤、可变输入与完成凭证", () => {
    const skill = compileSkill(base);
    expect(skill.hostname).toBe("example.com");
    expect(skill.name).toBe("把未跟进的客户整理出来");
    expect(skill.steps.map(s => s.kind)).toEqual(["click", "click", "type", "press", "click", "type", "type", "click"]);
    expect(skill.inputs).toEqual({ 客户名: "张三", 备注: "示范备注", 密码: "" });
    expect(skill.steps.find(s => s.inputKey === "密码")).toMatchObject({ redacted: true });
    expect(skill.steps[2]).toMatchObject({ kind: "type", inputKey: "客户名" });
    expect(skill.check.marker).toMatchObject({ tag: "button", name: "保存" });
    expect(skill.check.text).toContain("保存");
    expect(skill.version).toBe(1);
    expect(skill.runCount).toBe(0);
  });

  it("丢掉 submit：示范里的那次点击已经做过提交，重复提交更危险", () => {
    const skill = compileSkill(base);
    expect(skill.steps.some(s => (s as { kind: string }).kind === "submit")).toBe(false);
    expect(skill.program).not.toContain("requestSubmit");
  });

  it("脚本先解析再动作，解析不到就停，不点错", () => {
    const skill = compileSkill(base);
    expect(skill.program).toContain("async function resolveAnchor(anchor)");
    expect(skill.program).toContain("const target1 = await resolveStep(1);");
    expect(skill.program).toContain('await browser.fill({ target: target2, value: inputs["客户名"] ?? "" });');
    expect(skill.program).toContain("throw new Error(\"第 \" + (index + 1) + \" 步的目标在页面上找不到了");
    expect(skill.program).toContain("完成凭证不成立");
  });

  it("编译产物里没有坐标与 DOM 路径，且是合法 JS", () => {
    const skill = compileSkill(base);
    expect(validateCompiledSkill(skill)).toBeNull();
    expect(forbiddenInSkill(skill.program)).toBeNull();
    // 只做语法检查：browser 由运行环境提供
    expect(() => new Function("browser", `return (async () => {\n${skill.program}\n})();`)).not.toThrow();
  });

  it("敏感输入不进 inputs：只留下一个空位，值从哪里来由用户决定", () => {
    const skill = compileSkill(base);
    expect(JSON.stringify(skill.inputs)).not.toContain("hunter2");
    expect(skill.inputs["密码"]).toBe("");
  });

  it("没有可执行步骤时不产出半成品", () => {
    const skill = compileSkill({ ...base, steps: [{ at: 0, kind: "submit" }] });
    expect(validateCompiledSkill(skill)).toBe("示范里没有可编译的步骤");
  });

  it("没有输入的示范也能编译，完成凭证退回最后一步的对象", () => {
    const skill = compileSkill({ ...base, steps: [{ at: 0, kind: "click", anchor: { tag: "a", name: "下一步" } }] });
    expect(skill.inputs).toEqual({});
    expect(skill.check.marker).toMatchObject({ tag: "a", name: "下一步" });
    expect(skillStepsText(skill)).toEqual(["点击链接「下一步」"]);
    const typed = compileSkill({ ...base, steps: [{ at: 0, kind: "type", anchor: { tag: "input", inputType: "search", name: "客户名" }, value: "张三" }] });
    expect(skillStepsText(typed)).toEqual(["在搜索框「客户名」里输入「张三」"]);
    expect(skillStepsText(compileSkill(base)).at(-2)).toBe("在输入框「密码」里输入（内容已隐藏）");
  });
});

describe("站点作用域与红线", () => {
  it("hostname 归一化：去 www、转小写", () => {
    expect(normalizeSkillHost("WWW.Example.com")).toBe("example.com");
    expect(normalizeSkillHost(" app.example.com ")).toBe("app.example.com");
  });

  it("坐标、DOM 路径、选择器都算越线", () => {
    expect(forbiddenInSkill("div:nth-of-type(3)")).toBe("DOM 路径");
    expect(forbiddenInSkill("点 (120, 240)")).toBe("坐标");
    expect(forbiddenInSkill("document.querySelector('#x')")).toBe("选择器");
    expect(forbiddenInSkill("写死的 #submit-btn")).toBe("id 选择器");
    expect(forbiddenInSkill('document.querySelectorAll(spec.tag)')).toBeNull();
    expect(forbiddenInSkill("点击按钮「筛选」")).toBeNull();
  });
});

describe("卡片上的事实", () => {
  it("没跑过就说没跑过，不美化", () => {
    expect(skillRunSummary([])).toBe("还没跑过");
  });

  it("报次数、上次耗时、以及因页面变了停下的次数", () => {
    const runs = [
      { at: 1, ok: true, elapsedMs: 3200, steps: 11 },
      { at: 2, ok: false, elapsedMs: 900, steps: 4, failedStep: 3, error: "第 3 步的目标在页面上找不到了" },
      { at: 3, ok: true, elapsedMs: 2800, steps: 11 },
    ];
    expect(skillRunSummary(runs)).toBe("跑过 3 次 · 上次 2.8 秒 · 1 次因为页面变了停下");
  });

  it("上次失败就直说失败", () => {
    expect(skillRunSummary([{ at: 1, ok: false, elapsedMs: 400, steps: 1, error: "被接管，操作未执行" }])).toBe("跑过 1 次 · 上次失败");
  });
});

describe("编译出来的脚本真的能跑（真机教训：页面代码语法错误）", () => {
  /** 用真执行器跑一遍：把 browser.js 收到的页面代码抓出来解析，语法有问题这里就会抛。 */
  async function runAgainstStub(skill: ReturnType<typeof compileSkill>) {
    const pageCodes: string[] = [];
    const clicked: string[] = [];
    await runBrowserProgram({
      code: skill.program,
      call: async (name, params) => {
        if (name === "js") {
          const code = String((params as { code: string }).code);
          pageCodes.push(code);
          // 真机上的失败就在这里：页面代码本身不是合法 JS
          new Function(code);
          // 让解析成功，返回定位结果（真实页面脚本返回 { hit, reason, count }）
          return { value: { hit: '[data-sideagent-target]', reason: null, count: 1 } };
        }
        if (name === "click" || name === "fill" || name === "press_key") { clicked.push(name); return {}; }
        return {};
      },
    });
    return { pageCodes, clicked };
  }

  it("页面解析代码是合法 JS，且不靠转义引号", async () => {
    const skill = compileSkill(base);
    const { pageCodes } = await runAgainstStub(skill);
    expect(pageCodes.length).toBeGreaterThan(0);
    for (const code of pageCodes) {
      expect(code).toContain("data-sideagent-target");
      expect(code).not.toContain('\\"');
    }
  });

  it("每一步都先解析再动作，最后核对完成凭证", async () => {
    const skill = compileSkill(base);
    const { clicked, pageCodes } = await runAgainstStub(skill);
    // 只有带目标对象的步骤要解析（按键步骤不解析），再加上最后的凭证核对
    const resolves = skill.steps.filter(s => s.kind !== "press").length + 1;
    expect(pageCodes).toHaveLength(resolves);
    expect(clicked.filter(n => n === "click")).toHaveLength(skill.steps.filter(s => s.kind === "click").length);
  });

  it("解析不到就停下，不继续动作", async () => {
    const skill = compileSkill(base);
    const clicked: string[] = [];
    await expect(runBrowserProgram({
      code: skill.program,
      call: async (name, params) => {
        if (name === "js") { new Function(String((params as { code: string }).code)); return { value: null }; }
        clicked.push(name);
        return {};
      },
    })).rejects.toThrow(/第 1 步的目标在页面上找不到了/);
    expect(clicked).toHaveLength(0);
  });

  it("完成凭证优先取有名字的目标，不拿裸标签当凭证", () => {
    const skill = compileSkill({ ...base, steps: [...demo.slice(0, 5), { at: 2000, kind: "click", anchor: { tag: "a" } }] });
    expect(skill.check.marker).toMatchObject({ tag: "a", name: "第一条记录" });
    expect(skill.check.text).toContain("第一条记录");
  });
});

describe("记不到对象名的步骤", () => {
  it("标成弱步骤留下，不再静默丢掉（真机：B 站卡片全是裸 div）", () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "a", name: "Labels" } },
      { at: 900, kind: "click", anchor: { tag: "div" } },
      { at: 1800, kind: "click", anchor: { tag: "button", role: "button" } },
    ] });
    expect(skill.steps).toHaveLength(3);
    expect(skill.steps[1]).toMatchObject({ kind: "click", weak: true });
    expect(skill.weakSteps).toBe(1);
    expect(skill.check.marker).toMatchObject({ name: "Labels" });
  });

  it("弱步骤在程序里是「认不出来就跳过」而不是停下", () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "div" } },
      { at: 900, kind: "click", anchor: { tag: "a", name: "Labels" } },
    ] });
    expect(skill.program).toContain("const target0 = await tryResolveStep(0);");
    expect(skill.program).toContain("skipped.push(1)");
    expect(skill.program).toContain("const target1 = await resolveStep(1);");
  });

  it("有 role 的匿名对象保留：它还认得出来", () => {
    const skill = compileSkill({ ...base, steps: [{ at: 0, kind: "click", anchor: { tag: "div", role: "menuitem" } }] });
    expect(skill.steps).toHaveLength(1);
    expect(skill.droppedSteps).toBeUndefined();
  });

  it("全是没有名字的点击也不再产出空技能：它们作为弱步骤保留", () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "div" } },
      { at: 500, kind: "click", anchor: { tag: "div" } },
      { at: 900, kind: "click", anchor: { tag: "div" } },
    ] });
    expect(validateCompiledSkill(skill)).toBeNull();
    expect(skill.steps).toHaveLength(3);
    expect(skill.weakSteps).toBe(3);
  });
});

describe("可能过期：只看证据", () => {
  const fail = (failedStep?: number) => ({ at: 1, ok: false, elapsedMs: 10, steps: 1, ...(failedStep === undefined ? {} : { failedStep }), error: failedStep ? "第 N 步的目标在页面上找不到了" : "被接管，操作未执行" });

  it("连续三次因页面变了停下 → 可能过期", () => {
    const health = skillHealth([fail(1), fail(2), fail(3)]);
    expect(health.stale).toBe(true);
    expect(health.stalls).toBe(3);
    expect(health.reason).toContain("可能已经过期");
  });

  it("中间成功过一次就重新计数", () => {
    expect(skillHealth([fail(1), fail(2), { at: 3, ok: true, elapsedMs: 900, steps: 5 }, fail(1), fail(2)]).stale).toBe(false);
  });

  it("不是『页面变了』的失败不算过期（被接管、超时都不是技能老了）", () => {
    expect(skillHealth([fail(), fail(), fail()]).stale).toBe(false);
  });

  it("没过期就是普通的健康状态", () => {
    expect(skillHealth([]).stale).toBe(false);
    expect(skillHealth([{ at: 1, ok: true, elapsedMs: 1400, steps: 5 }]).stale).toBe(false);
  });
});

describe("全军覆没不算成功", () => {
  it("所有动作都是弱步骤时，程序在结尾明说没做成任何事", () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "div" } },
      { at: 500, kind: "click", anchor: { tag: "div" } },
    ] });
    expect(skill.program).toContain("if (skipped.length >= 2)");
    expect(skill.program).toContain("技能什么都没做成");
  });

  it("只有按键步骤时不加这条：按键本身不需要解析对象", () => {
    const skill = compileSkill({ ...base, steps: [{ at: 0, kind: "press", key: "Enter" }] });
    expect(skill.program).not.toContain("技能什么都没做成");
  });

  it("真跑一遍：弱步骤全认不出来 → 明确报错，不假装完成", async () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "div" } },
      { at: 600, kind: "click", anchor: { tag: "div" } },
    ] });
    await expect(runBrowserProgram({
      code: skill.program,
      call: async (name, params) => {
        if (name === "js") { new Function(String((params as { code: string }).code)); return { value: null }; }
        return {};
      },
    })).rejects.toThrow(/什么都没做成/);
  });

  it("部分认出：跳过的那几步如实报出来", async () => {
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "div" } },
      { at: 600, kind: "click", anchor: { tag: "a", name: "Labels" } },
    ] });
    let resolveCount = 0;
    const result = await runBrowserProgram({
      code: skill.program,
      call: async (name, params) => {
        if (name === "js") {
          new Function(String((params as { code: string }).code));
          resolveCount += 1;
          return { value: resolveCount === 1 ? { hit: null, reason: "none", count: 0 } : { hit: '[data-sideagent-target]', reason: null, count: 1 } };
        }
        return {};
      },
    });
    expect((result.value as { skipped?: number[] }).skipped).toEqual([1]);
  });
});

/**
 * 真机失败（2026-09-13，scripts/fixtures/feature-journeys.html）：
 * 「看我做 → 编译 → 照上次跑」在**同源同结构**的新页面上第 1 步就「目标找不到」。
 * 城市是 <label for="city">城市</label> + 无 aria-label 的输入框；保存按钮的父节点里
 * 还并排着「清空本场景状态」，录制把两个按钮的文字拼成了一个不存在的名字。
 *
 * 这一组不检查字符串，直接用真执行器跑**真正生成的 program**：页面代码在我们按
 * 真实结构搭的 DOM 上求值，断言它 fill 到哪个输入框、click 到哪个按钮。
 */
class DomNode {
  tagName: string;
  attrs: Record<string, string>;
  text: string;
  labels: DomNode[] = [];
  parent: DomNode | null = null;

  constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.text = text;
  }

  get id(): string { return this.attrs.id ?? ""; }
  get textContent(): string { return this.text; }
  get parentElement(): DomNode | null { return this.parent; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  querySelector(_selector: string): DomNode | null { return null; }
}

class DomDocument {
  constructor(public nodes: DomNode[]) {}
  querySelectorAll(selector: string): DomNode[] {
    if (selector === "[data-sideagent-target]") return this.nodes.filter(n => n.getAttribute("data-sideagent-target") !== null);
    return this.nodes.filter(n => n.tagName.toLowerCase() === selector.toLowerCase());
  }
  getElementById(id: string): DomNode | null { return this.nodes.find(n => n.id === id) ?? null; }
}

/** feature-journeys.html 里与本次失败相关的那一小块结构。 */
function cityAndSaveFixture(): { doc: DomDocument; city: DomNode; save: DomNode; reset: DomNode } {
  const city = new DomNode("input", { id: "city", name: "city", type: "text", placeholder: "例如：杭州" });
  city.labels = [new DomNode("label", { for: "city" }, "城市")];
  const nameInput = new DomNode("input", { id: "name", name: "name", type: "text", placeholder: "例如：林然" });
  nameInput.labels = [new DomNode("label", { for: "name" }, "姓名")];
  const save = new DomNode("button", { id: "save-btn", type: "button" }, "保存到本页内存");
  const reset = new DomNode("button", { id: "reset-btn", type: "button" }, "清空本场景状态");
  // 父节点的 textContent 就是两个按钮文字拼起来（之间有空白）——录制误取祖先文字时的来源。
  const field = new DomNode("div", { class: "field" }, "\n      保存到本页内存\n      \n      清空本场景状态\n    ");
  save.parent = field;
  reset.parent = field;
  return { doc: new DomDocument([city, nameInput, save, reset, field]), city, save, reset };
}

/** 把 browser.js 收到的页面代码丢进这份 DOM 求值；click/fill 只记录目标，不真点。 */
function domBackedBrowser(doc: DomDocument) {
  const actions: Array<{ name: string; target: DomNode | null; value?: unknown }> = [];
  const call = async (name: string, params: Record<string, unknown>) => {
    if (name === "js") {
      const code = String(params.code);
      return { value: new Function("document", `return (${code});`)(doc) };
    }
    if (name === "click" || name === "fill") {
      const target = doc.querySelectorAll(String(params.target))[0] ?? null;
      actions.push({ name, target, value: params.value });
      return {};
    }
    return {};
  };
  return { actions, call };
}

describe("真实页面：label-only 输入 + 并排两个按钮", () => {
  it("生成的 program 在 DOM 上认得出 label 命名的城市输入框，并 fill/click 到对的元素", async () => {
    const { doc, city, save } = cityAndSaveFixture();
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "input", name: "城市" } },
      { at: 60, kind: "type", anchor: { tag: "input", name: "城市" }, value: "复用城" },
      { at: 400, kind: "click", anchor: { tag: "button", name: "保存到本页内存" } },
    ] });
    const { actions, call } = domBackedBrowser(doc);
    const result = await runBrowserProgram({ code: skill.program, call });
    expect(result.value).toMatchObject({ done: true, steps: 3 });
    expect(actions.map(a => a.name)).toEqual(["click", "fill", "click"]);
    expect(actions[1]?.target).toBe(city);
    expect(actions[1]?.value).toBe("复用城");
    expect(actions[2]?.target).toBe(save);
  });

  it("两个同名按钮时停下报歧义，不点第一个也不点错", async () => {
    const doc = new DomDocument([
      new DomNode("button", { id: "a" }, "保存"),
      new DomNode("button", { id: "b" }, "保存"),
    ]);
    const skill = compileSkill({ ...base, steps: [{ at: 0, kind: "click", anchor: { tag: "button", name: "保存" } }] });
    const { actions, call } = domBackedBrowser(doc);
    await expect(runBrowserProgram({ code: skill.program, call })).rejects.toThrow(/2 个同名对象/);
    expect(actions).toHaveLength(0);
  });

  it("拼了两个按钮的旧锚点在新页面上找不到任何目标，绝不退化成随便点一个", async () => {
    const { doc } = cityAndSaveFixture();
    const skill = compileSkill({ ...base, steps: [
      { at: 0, kind: "click", anchor: { tag: "button", name: "保存到本页内存 清空本场景状态" } },
    ] });
    const { actions, call } = domBackedBrowser(doc);
    await expect(runBrowserProgram({ code: skill.program, call })).rejects.toThrow(/第 1 步的目标在页面上找不到了/);
    expect(actions).toHaveLength(0);
  });
});

it('高优先级label不能被另一个字段的placeholder冒充', async () => {
  const { doc, city } = cityAndSaveFixture();
  const nameField = doc.nodes.find(n => n.id === 'name')!;
  nameField.setAttribute('placeholder', '城市');
  const skill = compileSkill({ ...base, steps: [{at:0, kind:'type',anchor:{tag:'input',name:'城市'},value:'复用城'}] });
  const {actions,call} = domBackedBrowser(doc);
  await runBrowserProgram({code:skill.program,call});
  expect(actions).toHaveLength(1);
  expect(actions[0]?.target).toBe(city);
});
