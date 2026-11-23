import assert from "node:assert/strict";
import { test } from "node:test";
import { isDirectAskTypingKey, isSelectionArrowOrShiftKey } from "../extension/src/shared/ask-selection.js";

test("键名缺失时不触发划词或直接提问，输入法 229 仍可开始输入", () => {
  for (const key of [undefined, null, 13]) {
    assert.equal(isSelectionArrowOrShiftKey(key), false);
    assert.equal(isDirectAskTypingKey(key), false);
    assert.equal(isDirectAskTypingKey(key, 229), true);
  }
});

test("划词只跟随 Shift 和方向键，直接提问接受文字和输入法", () => {
  for (const key of ["Shift", "ArrowLeft", "ArrowDown"]) {
    assert.equal(isSelectionArrowOrShiftKey(key), true);
    assert.equal(isDirectAskTypingKey(key), false);
  }
  for (const key of ["a", "字", "Process"]) {
    assert.equal(isSelectionArrowOrShiftKey(key), false);
    assert.equal(isDirectAskTypingKey(key), true);
  }
  for (const key of [" ", "", "Tab"]) {
    assert.equal(isSelectionArrowOrShiftKey(key), false);
    assert.equal(isDirectAskTypingKey(key), false);
  }
});
