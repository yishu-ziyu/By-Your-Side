import { describe, expect, it } from "vitest";
import { classifyToolEffect, requiresControlGate } from "../../shared/effect-policy.js";

describe("effect policy", () => {
  it("treats fetch POST and bodies as gated writes", () => {
    expect(classifyToolEffect("fetch", { url: "https://example.com", method: "POST", body: "{}" })).toMatchObject({
      class: "write",
      requiresControlGate: true,
    });
  });

  it("still gates fetch GET because cookies travel with the request", () => {
    const decision = classifyToolEffect("fetch", { url: "https://example.com", method: "GET" });
    expect(decision.requiresControlGate).toBe(true);
    expect(decision.class).toBe("unknown");
  });

  it("does not treat snapshot as a write", () => {
    expect(requiresControlGate("snapshot", {})).toBe(false);
    expect(classifyToolEffect("snapshot").class).toBe("read");
  });

  it("treats raw js and enter keys as gated writes", () => {
    expect(classifyToolEffect("js", { code: "document.title" }).requiresControlGate).toBe(true);
    expect(classifyToolEffect("press_key", { key: "Enter" }).requiresControlGate).toBe(true);
  });
});
