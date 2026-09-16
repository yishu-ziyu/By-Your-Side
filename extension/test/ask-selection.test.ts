import { describe, expect, it } from "vitest";
import { EXPLAIN_PROMPT, MAX_ASK_CHARS, clipSelection } from "../src/shared/ask-selection.js";

describe("clipSelection", () => {
  it("rejects empty or one-character scraps", () => {
    expect(clipSelection("")).toBeNull();
    expect(clipSelection("  a  ")).toBeNull();
  });

  it("keeps paragraph and code whitespace", () => {
    expect(clipSelection("  MiroFish\n  is  ")).toBe("MiroFish\n  is");
  });

  it("truncates at the explicit selection limit", () => {
    const raw = `ab${"x".repeat(MAX_ASK_CHARS)}`;
    const out = clipSelection(raw);
    expect(out).toHaveLength(MAX_ASK_CHARS);
    expect(out?.startsWith("ab")).toBe(true);
  });
});

describe("EXPLAIN_PROMPT", () => {
  it("tells the model to explain without operating the page", () => {
    expect(EXPLAIN_PROMPT).toContain("解释");
    expect(EXPLAIN_PROMPT).toContain("不要操作页面");
  });
});
