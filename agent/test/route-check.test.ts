// 提交前核对的判断结果怎么读、什么时候不用问（YIS-96）。失败方式先列：
// 1 模型写「现在 10 月 15 日，你要 10 月 15 日」却判不过，被当成对不上；2 真的对不上被放过；3 回复不是约定的格式也算通过；
// 4 值都在用户原话里还去问模型（多等几秒）；5 有一个值不在原话里也直接放过。
import { describe, expect, it } from "vitest";
import { literallyAsked, parseRouteCheck, type CheckField } from "../src/route-check.js";

const f = (field: string, value: string, from: CheckField["from"] = "said"): CheckField => ({ step: 1, field, value, from });

describe("提交前核对", () => {
  it("只把「现在」和「你说的」真不同的项算对不上", () => {
    expect(parseRouteCheck('{"mismatches":[{"field":"日期","now":"10月15日","asked":"10 月 15 日（周四）"}]}')).toEqual({ ok: true });
    expect(parseRouteCheck('{"mismatches":[]}')).toEqual({ ok: true });
    expect(parseRouteCheck('{"mismatches":[{"field":"会议室","now":"青松","asked":"白桦"}]}')).toEqual({ ok: false, problem: "会议室现在是「青松」，你这次说的是「白桦」" });
  });

  it("格式不对不算通过", () => {
    expect(() => parseRouteCheck('{"ok":true}')).toThrow();
  });

  it("值都在用户这次的原话里：不用问模型；有一个不在就要问", () => {
    const asked = ["在当前网页订会议室：10 月 15 日（周四）14:00–15:00，白桦，主题写复盘。"];

    expect(literallyAsked([f("日期", "10 月 15 日（周四）"), f("会议室", "白桦"), f("会议主题", "复盘")], asked)).toBe(true);
    expect(literallyAsked([f("日期", "10 月 15 日（周四）"), f("人数", "8", "fixed")], asked)).toBe(false);
    expect(literallyAsked([f("日期", "10 月 8 日（周四）", "fixed")], ["下周四同一时间再订一次"])).toBe(false);
  });
});
