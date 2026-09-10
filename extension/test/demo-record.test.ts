import { describe, expect, it } from "vitest";
import {
  anchorFor,
  byteLength,
  describeStep,
  describeSteps,
  isSensitiveField,
  pushStep,
  recordingHint,
  scrubUrl,
  type DemoStep,
} from "../../shared/demo-record.js";

const L = { maxSteps: 100, maxBytes: 64_000, mergeWindowMs: 2_000 };

/** noUncheckedIndexedAccess 下的取值助手 */
const at = (steps: DemoStep[], i: number): DemoStep => steps[i]!;

function type(at: number, name: string, value?: string, redacted?: true): DemoStep {
  return { at, kind: "type", anchor: { tag: "input", name }, ...(redacted ? { redacted } : { value }) };
}

describe("anchorFor", () => {
  it("优先用 aria-label，其次关联 label、placeholder、可见文字", () => {
    expect(anchorFor({ tag: "INPUT", type: "TEXT", ariaLabel: "客户名", placeholder: "搜客户" }).name).toBe("客户名");
    expect(anchorFor({ tag: "input", label: "金额", placeholder: "0.00" }).name).toBe("金额");
    expect(anchorFor({ tag: "button", text: "  下一步  " }).name).toBe("下一步");
  });

  it("长文本截断，text 类型不写进锚点", () => {
    const a = anchorFor({ tag: "button", text: "x".repeat(200) });
    expect(a.name?.length).toBeLessThanOrEqual(60);
    expect(anchorFor({ tag: "input", type: "text" }).inputType).toBeUndefined();
    expect(anchorFor({ tag: "input", type: "search" }).inputType).toBe("search");
  });
});

describe("真机上的裸 div（B 站视频卡那种）", () => {
  it("名字从祖先文字、title、图片 alt 里取", () => {
    expect(anchorFor({ tag: "div", ancestorText: "【明日方舟】主线剧情合集" }).name).toBe("【明日方舟】主线剧情合集");
    expect(anchorFor({ tag: "div", title: "点击查看" }).name).toBe("点击查看");
    expect(anchorFor({ tag: "div", alt: "封面：某个视频" }).name).toBe("封面：某个视频");
  });

  it("优先级：显式标签 > title > 祖先文字 > 自身文字", () => {
    expect(anchorFor({ tag: "div", ariaLabel: "卡片", title: "标题", ancestorText: "祖先" }).name).toBe("卡片");
    expect(anchorFor({ tag: "div", title: "标题", ancestorText: "祖先" }).name).toBe("标题");
    expect(anchorFor({ tag: "div", ancestorText: "祖先", text: "自身" }).name).toBe("祖先");
  });
});

describe("敏感字段", () => {
  it("密码、卡号、验证码一律敏感", () => {
    expect(isSensitiveField({ tag: "input", type: "password" })).toBe(true);
    expect(isSensitiveField({ tag: "input", autocomplete: "cc-number" })).toBe(true);
    expect(isSensitiveField({ tag: "input", name: "smsCode" })).toBe(true);
    expect(isSensitiveField({ tag: "input", placeholder: "请输入验证码" })).toBe(true);
    expect(isSensitiveField({ tag: "input", placeholder: "客户名称" })).toBe(false);
  });
});

describe("页面地址", () => {
  it("只留 origin + pathname，查询串与锚点不记", () => {
    expect(scrubUrl("https://x.com/a/b?token=1#frag")).toBe("https://x.com/a/b?…");
    expect(scrubUrl("https://x.com/a/b")).toBe("https://x.com/a/b");
    expect(scrubUrl("about:blank")).toBeUndefined();
  });
});

describe("步骤合并与预算", () => {
  it("同一个输入框的连续输入合成一步，超过窗口另起一步", () => {
    let steps = pushStep([], type(0, "客户名", "张"), L).steps;
    steps = pushStep(steps, type(120, "客户名", "张三"), L).steps;
    expect(steps).toHaveLength(1);
    expect(at(steps, 0).value).toBe("张三");
    expect(at(steps, 0).repeats).toBe(2);
    steps = pushStep(steps, type(9_000, "客户名", "李四"), L).steps;
    expect(steps).toHaveLength(2);
  });

  it("不同对象不合并；连点同一对象 400ms 内合并", () => {
    let steps = pushStep([], { at: 0, kind: "click", anchor: { tag: "button", name: "下一步" } }, L).steps;
    steps = pushStep(steps, { at: 100, kind: "click", anchor: { tag: "button", name: "下一步" } }, L).steps;
    steps = pushStep(steps, { at: 200, kind: "click", anchor: { tag: "button", name: "返回" } }, L).steps;
    expect(steps).toHaveLength(2);
    expect(at(steps, 0).repeats).toBe(2);
    expect(at(steps, 1).anchor?.name).toBe("返回");
    expect(describeSteps(steps)).toEqual(["点击按钮「下一步」 ×2", "点击按钮「返回」"]);
  });

  it("触顶如实标记 truncated，并把步骤截在预算内", () => {
    let steps: DemoStep[] = [];
    let truncated = false;
    for (let i = 0; i < 5; i += 1) {
      const r = pushStep(steps, { at: i * 5_000, kind: "click", anchor: { tag: "button", name: `第${i}个` } }, { ...L, maxSteps: 3 });
      steps = r.steps;
      truncated = truncated || r.truncated;
    }
    expect(steps).toHaveLength(3);
    expect(truncated).toBe(true);
    expect(recordingHint(steps, truncated)).toContain("不再记录");
  });

  it("字节预算按 UTF-8 算，超了就丢尾部并标记", () => {
    let steps: DemoStep[] = [];
    let truncated = false;
    for (let i = 0; i < 20; i += 1) {
      const r = pushStep(steps, type(i * 5_000, `字段${i}`, "值".repeat(50)), { ...L, maxBytes: 1_200 });
      steps = r.steps;
      truncated = truncated || r.truncated;
    }
    expect(truncated).toBe(true);
    expect(byteLength(steps)).toBeLessThanOrEqual(1_200);
  });

  it("敏感输入合并后不残留内容", () => {
    let steps = pushStep([], type(0, "密码", undefined, true), L).steps;
    steps = pushStep(steps, type(100, "密码", undefined, true), L).steps;
    expect(at(steps, 0).value).toBeUndefined();
    expect(at(steps, 0).redacted).toBe(true);
    expect(JSON.stringify(steps)).not.toContain("密码值");
    expect(describeStep(at(steps, 0))).toBe("在输入框「密码」里输入（内容已隐藏） ×2");
  });
});

describe("人话描述", () => {
  it("只描述对象与动作，不出现坐标与选择器", () => {
    const lines = describeSteps([
      { at: 0, kind: "click", anchor: { tag: "button", name: "筛选" } },
      { at: 10, kind: "type", anchor: { tag: "input", inputType: "search", name: "客户" }, value: "张三" },
      { at: 20, kind: "press", key: "Enter" },
      { at: 30, kind: "click", anchor: { tag: "a", name: "第一条记录" } },
    ]);
    expect(lines).toEqual([
      "点击按钮「筛选」",
      "在搜索框「客户」里输入「张三」",
      "按 回车",
      "点击链接「第一条记录」",
    ]);
    for (const line of lines) expect(line).not.toMatch(/nth-of-type|#[\w-]+\s*>|\(\d+,\s*\d+\)/);
  });
});
