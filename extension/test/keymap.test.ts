import { describe, expect, it } from "vitest";
import { resolveKey } from "../src/shared/keymap.js";

describe("resolveKey 常用键", () => {
  it("Enter 带回车文本", () => {
    expect(resolveKey("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
    });
  });

  it("Tab / Escape / Backspace / Delete", () => {
    expect(resolveKey("Tab")).toMatchObject({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 0 });
    expect(resolveKey("Escape")).toMatchObject({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    expect(resolveKey("Backspace")).toMatchObject({ key: "Backspace", windowsVirtualKeyCode: 8 });
    expect(resolveKey("Delete")).toMatchObject({ key: "Delete", windowsVirtualKeyCode: 46 });
  });

  it("方向键与导航键", () => {
    expect(resolveKey("ArrowUp")).toMatchObject({ code: "ArrowUp", windowsVirtualKeyCode: 38 });
    expect(resolveKey("ArrowDown")).toMatchObject({ code: "ArrowDown", windowsVirtualKeyCode: 40 });
    expect(resolveKey("ArrowLeft")).toMatchObject({ code: "ArrowLeft", windowsVirtualKeyCode: 37 });
    expect(resolveKey("ArrowRight")).toMatchObject({ code: "ArrowRight", windowsVirtualKeyCode: 39 });
    expect(resolveKey("Home")).toMatchObject({ windowsVirtualKeyCode: 36 });
    expect(resolveKey("End")).toMatchObject({ windowsVirtualKeyCode: 35 });
    expect(resolveKey("PageUp")).toMatchObject({ windowsVirtualKeyCode: 33 });
    expect(resolveKey("PageDown")).toMatchObject({ windowsVirtualKeyCode: 34 });
  });

  it("Space 带空格文本", () => {
    expect(resolveKey("Space")).toEqual({
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      modifiers: 0,
      text: " ",
    });
  });

  it("字母与数字", () => {
    expect(resolveKey("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, text: "a" });
    expect(resolveKey("z")).toMatchObject({ code: "KeyZ", windowsVirtualKeyCode: 90 });
    expect(resolveKey("0")).toEqual({ key: "0", code: "Digit0", windowsVirtualKeyCode: 48, modifiers: 0, text: "0" });
    expect(resolveKey("9")).toMatchObject({ code: "Digit9", windowsVirtualKeyCode: 57 });
  });
});

describe("resolveKey 组合键", () => {
  it("Control+A：modifiers=2，不生成文本", () => {
    const k = resolveKey("Control+A");
    expect(k).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    expect(k?.text).toBeUndefined();
  });

  it("Meta+A：modifiers=4", () => {
    expect(resolveKey("Meta+A")).toMatchObject({ modifiers: 4, code: "KeyA" });
  });

  it("Shift+Tab：modifiers=8", () => {
    expect(resolveKey("Shift+Tab")).toMatchObject({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
  });

  it("Shift+A：大写 key 与 text", () => {
    expect(resolveKey("Shift+A")).toMatchObject({ key: "A", code: "KeyA", modifiers: 8, text: "A" });
  });

  it("Control+Shift+ArrowLeft：modifiers=10", () => {
    expect(resolveKey("Control+Shift+ArrowLeft")).toMatchObject({ modifiers: 10, code: "ArrowLeft" });
  });

  it("修饰键别名 Ctrl / Cmd / Option", () => {
    expect(resolveKey("Ctrl+C")?.modifiers).toBe(2);
    expect(resolveKey("Cmd+V")?.modifiers).toBe(4);
    expect(resolveKey("Command+P")?.modifiers).toBe(4);
    expect(resolveKey("Option+ArrowLeft")?.modifiers).toBe(1);
  });

  it("修饰键大小写不敏感", () => {
    expect(resolveKey("control+a")?.modifiers).toBe(2);
    expect(resolveKey("shift+tab")).toMatchObject({ code: "Tab", modifiers: 8 });
  });
});

describe("resolveKey 未知键返回 null", () => {
  it("未支持的键名与非法组合", () => {
    expect(resolveKey("F1")).toBeNull();
    expect(resolveKey("Foo")).toBeNull();
    expect(resolveKey("")).toBeNull();
    expect(resolveKey("A+B")).toBeNull();
    expect(resolveKey("Control+")).toBeNull();
    expect(resolveKey("ab")).toBeNull();
  });
});
