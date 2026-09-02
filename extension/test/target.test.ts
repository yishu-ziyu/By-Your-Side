import { describe, expect, it } from "vitest";
import { parseTarget } from "../src/shared/target.js";

describe("parseTarget", () => {
  it("解析 @N ref", () => {
    expect(parseTarget("@1")).toEqual({ kind: "ref", n: 1 });
    expect(parseTarget("@42")).toEqual({ kind: "ref", n: 42 });
    expect(parseTarget("  @7  ")).toEqual({ kind: "ref", n: 7 });
  });

  it("解析 loc=css: 定位串（去前缀即 CSS）", () => {
    expect(parseTarget("loc=css:#submit")).toEqual({ kind: "loc", sel: "#submit" });
    expect(parseTarget("loc=css:body > div:nth-of-type(2)")).toEqual({
      kind: "loc",
      sel: "body > div:nth-of-type(2)",
    });
  });

  it("其他非空字符串按原始 CSS 处理", () => {
    expect(parseTarget("#main .btn")).toEqual({ kind: "css", sel: "#main .btn" });
    expect(parseTarget("button")).toEqual({ kind: "css", sel: "button" });
    expect(parseTarget("loc=other:#x")).toEqual({ kind: "css", sel: "loc=other:#x" });
  });

  it("非法输入返回 null", () => {
    expect(parseTarget("")).toBeNull();
    expect(parseTarget("   ")).toBeNull();
    expect(parseTarget("@")).toBeNull();
    expect(parseTarget("@0")).toBeNull();
    expect(parseTarget("@-1")).toBeNull();
    expect(parseTarget("@1.5")).toBeNull();
    expect(parseTarget("@abc")).toBeNull();
    expect(parseTarget("loc=css:")).toBeNull();
    expect(parseTarget("loc=css:   ")).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
    expect(parseTarget(null)).toBeNull();
    expect(parseTarget(123)).toBeNull();
  });
});
