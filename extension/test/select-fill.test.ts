import { describe, expect, it } from "vitest";
import { matchSelectOption } from "../../shared/select-fill.js";

describe("fill a native select by label", () => {
  const options = [
    { text: "请选择", value: "" },
    { text: "杭州", value: "hz" },
    { text: "上海", value: "sh" },
  ];

  it("matches visible label or value", () => {
    expect(matchSelectOption(options, "杭州")).toEqual({ text: "杭州", value: "hz" });
    expect(matchSelectOption(options, "hz")).toEqual({ text: "杭州", value: "hz" });
  });

  it("does not pretend the placeholder is a city", () => {
    expect(matchSelectOption(options, "请选择")).toEqual({ text: "请选择", value: "" });
    expect(matchSelectOption(options, "北京")).toBeNull();
  });
});
