/**
 * 录制端取名字的语义（extension/src/shared/dom-anchor.ts）。
 *
 * 真机失败（2026-09-13，scripts/fixtures/feature-journeys.html）：
 * 保存按钮的父节点里并排着「清空本场景状态」，录制把父节点的两段文字拼成了
 * 「保存到本页内存 清空本场景状态」——一个页面上根本不存在的对象名，
 * 同源同结构的新页面重放时第 1 步就找不到目标。
 *
 * 这里锁住三件事：输入框按关联 label 取名（重放端要认这个名字）；
 * 有自己文字的按钮不越级取父节点文字；没文字的裸 div 仍然从祖先文字取名。
 */
import { describe, expect, it } from "vitest";
import { anchorOfTarget, ancestorTextOf, sourceOf } from "../src/shared/dom-anchor.js";
import { anchorFor } from "../../shared/demo-record.js";

class FakeElement {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  parentElement: FakeElement | null = null;
  labels: FakeElement[] = [];

  constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.textContent = text;
  }

  get id(): string { return this.attrs.id ?? ""; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  querySelector(_selector: string): FakeElement | null { return null; }
}

// dom-anchor 的入口用 `target instanceof Element` 判断；node 环境里补一个最小原型。
(globalThis as unknown as { Element: unknown }).Element = FakeElement;

const anchorName = (el: FakeElement): string | undefined =>
  anchorOfTarget(el as unknown as EventTarget)?.anchor.name;

describe("并排两个按钮：只录按钮自己的文字", () => {
  const save = new FakeElement("button", { id: "save-btn", type: "button" }, "保存到本页内存");
  const reset = new FakeElement("button", { id: "reset-btn", type: "button" }, "清空本场景状态");
  // 父节点 textContent 就是两段按钮文字拼起来（真实页面里按钮之间有换行与缩进）。
  const field = new FakeElement("div", { class: "field" }, "\n      保存到本页内存\n      \n      清空本场景状态\n    ");
  save.parentElement = field;
  reset.parentElement = field;

  it("录到的是「保存到本页内存」，不是 父节点两段文字拼起来的名字", () => {
    expect(anchorName(save)).toBe("保存到本页内存");
    expect(anchorName(reset)).toBe("清空本场景状态");
  });

  it("元素自己已经有文字时，祖先文字不再参与取名", () => {
    expect(ancestorTextOf(save as unknown as Element)).toBeNull();
    expect(sourceOf(save as unknown as Element).ancestorText).toBeNull();
  });
});

describe("label-only 的输入框", () => {
  it("按关联 label 取名（无 aria-label / placeholder 不是名字时也一样）", () => {
    const city = new FakeElement("input", { id: "city", name: "city", type: "text" });
    city.labels = [new FakeElement("label", { for: "city" }, "城市")];
    expect(anchorFor(sourceOf(city as unknown as Element))).toMatchObject({ tag: "input", name: "城市" });
    expect(anchorName(city)).toBe("城市");
  });
});

describe("没有文字的裸 div（B 站卡片那种）不退化", () => {
  it("仍然从祖先文字取名", () => {
    const card = new FakeElement("div", { class: "card" }, "【明日方舟】主线剧情合集");
    const thumb = new FakeElement("div");
    thumb.parentElement = card;
    expect(anchorName(thumb)).toBe("【明日方舟】主线剧情合集");
  });
});
