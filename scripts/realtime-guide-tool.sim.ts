import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REALTIME_BROWSER_INSTRUCTIONS,
  REALTIME_BROWSER_TOOL_NAMES,
  REALTIME_BROWSER_TOOLS,
  validateRealtimeBrowserTool,
} from "../agent/src/realtime-browser-tools.js";
import {
  TEACH_MENU_ID,
  TEACH_PAGE_DRAFT,
  TEACH_SELECTION_DRAFT,
} from "../extension/src/shared/ask-selection.js";

describe("realtime voice guide_step integration and page teach entrypoints", () => {
  it("exposes guide_step in realtime browser tools and voice instructions", () => {
    assert.ok(REALTIME_BROWSER_TOOL_NAMES.includes("guide_step"));
    const def = REALTIME_BROWSER_TOOLS.find((t) => t.function.name === "guide_step");
    assert.ok(def, "guide_step tool schema should be exported for realtime voice");
    const props = (def.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("target" in props && "say" in props && "step" in props);
    assert.ok(REALTIME_BROWSER_INSTRUCTIONS.includes("guide_step"));
  });

  it("validates guide_step arguments and rejects malformed or unknown fields", () => {
    assert.doesNotThrow(() => {
      validateRealtimeBrowserTool("guide_step", { target: "@12", say: "点右上角设置", step: 1 });
    });

    assert.throws(
      () => validateRealtimeBrowserTool("guide_step", { target: "@12", step: 1 }),
      (err: unknown) => (err as { executionFact?: string })?.executionFact === "not_executed",
    );

    assert.throws(
      () => validateRealtimeBrowserTool("guide_step", { target: "@12", say: "点设置", step: 0 }),
      (err: unknown) => (err as { executionFact?: string })?.executionFact === "not_executed",
    );

    assert.throws(
      () => validateRealtimeBrowserTool("guide_step", { target: "@12", say: "点设置", step: 1, extra: true }),
      (err: unknown) => (err as { executionFact?: string })?.executionFact === "not_executed",
    );
  });

  it("defines clean Chinese page teach menu and draft prompts", () => {
    assert.equal(TEACH_MENU_ID, "teach-sideagent");
    assert.ok(TEACH_SELECTION_DRAFT.includes("一步一步"));
    assert.ok(TEACH_PAGE_DRAFT.includes("一步一步"));
  });
});
