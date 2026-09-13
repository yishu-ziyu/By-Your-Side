import { describe, expect, it } from "vitest";
import { classifyToolEffect, needsConsentTicket, requiresControlGate } from "../../shared/effect-policy.js";

describe("effect policy", () => {
  it("treats fetch POST and bodies as writes that need consent", () => {
    expect(classifyToolEffect("fetch", { url: "https://example.com", method: "POST", body: "{}" })).toMatchObject({
      class: "write",
      requiresControlGate: true,
      needsConsent: true,
    });
    expect(needsConsentTicket("fetch", { method: "post", body: "x" })).toBe(true);
  });

  it("still gates fetch GET because cookies travel with the request", () => {
    const decision = classifyToolEffect("fetch", { url: "https://example.com", method: "GET" });
    expect(decision.requiresControlGate).toBe(true);
    expect(decision.needsConsent).toBe(false);
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

  it("does not grant a blanket POST search exemption", () => {
    expect(needsConsentTicket("fetch", { method: "POST", url: "https://api.github.com/search" })).toBe(true);
  });
});
