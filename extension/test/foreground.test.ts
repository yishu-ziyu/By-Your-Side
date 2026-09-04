import { describe, expect, it } from "vitest";
import { mayActivateTabInWindow } from "../src/background/foreground.js";

describe("mayActivateTabInWindow", () => {
  it("only activates when the Chrome window is already focused", () => {
    expect(mayActivateTabInWindow(true)).toBe(true);
    expect(mayActivateTabInWindow(false)).toBe(false);
    expect(mayActivateTabInWindow(undefined)).toBe(false);
  });
});
