import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyGuideTarget,
  formatGuideFieldAfter,
  isSensitiveGuideField,
  shouldCompleteInput,
} from "../extension/src/shared/guide-intent.js";

describe("live tutor guide target intent and completion rules", () => {
  it("classifies click, text input, and select targets accurately", () => {
    assert.equal(classifyGuideTarget({ tagName: "BUTTON" }), "click");
    assert.equal(classifyGuideTarget({ tagName: "INPUT", inputType: "checkbox" }), "click");
    assert.equal(classifyGuideTarget({ tagName: "INPUT", inputType: "submit" }), "click");
    assert.equal(classifyGuideTarget({ tagName: "INPUT", inputType: "text" }), "input");
    assert.equal(classifyGuideTarget({ tagName: "INPUT", inputType: "search" }), "input");
    assert.equal(classifyGuideTarget({ tagName: "INPUT", inputType: "password" }), "input");
    assert.equal(classifyGuideTarget({ tagName: "TEXTAREA" }), "input");
    assert.equal(classifyGuideTarget({ tagName: "DIV", contentEditable: true }), "input");
    assert.equal(classifyGuideTarget({ tagName: "DIV", role: "searchbox" }), "input");
    assert.equal(classifyGuideTarget({ tagName: "SELECT" }), "select");
  });

  it("redacts passwords and sensitive tokens from guide_step readback", () => {
    assert.equal(isSensitiveGuideField("password", "login"), true);
    assert.equal(isSensitiveGuideField("text", "API token"), true);
    assert.equal(isSensitiveGuideField("text", "短信验证码"), true);
    assert.equal(isSensitiveGuideField("text", "搜索关键词"), false);

    const secretAfter = formatGuideFieldAfter("input", "Password", { value: "s3cr3t-pass", sensitive: true });
    assert.ok(!secretAfter.includes("s3cr3t-pass"));
    assert.ok(secretAfter.includes("redacted"));

    const plainAfter = formatGuideFieldAfter("input", "搜索", { value: "By Your Side", sensitive: false });
    assert.ok(plainAfter.includes("By Your Side"));
  });

  it("requires actual value change before completing text input steps", () => {
    assert.equal(shouldCompleteInput("", "", "enter"), false);
    assert.equal(shouldCompleteInput("old", "old", "blur"), false);
    assert.equal(shouldCompleteInput("old", "   ", "idle"), false);
    assert.equal(shouldCompleteInput("", "hello", "idle"), true);
    assert.equal(shouldCompleteInput("old", "", "enter"), true);
    assert.equal(shouldCompleteInput("old", "new", "blur"), true);
    assert.equal(shouldCompleteInput("old", "new", "change"), true);
  });
});
