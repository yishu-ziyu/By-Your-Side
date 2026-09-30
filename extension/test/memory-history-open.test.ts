import { describe, expect, it } from "vitest";
import { MemoryHistoryOpen } from "../src/sidepanel/memory-history-open.js";

/** 模拟面板：每次渲染新建一个 <details>，按 main.ts 的方式套用状态。 */
function render(state: MemoryHistoryOpen, forced: boolean) {
  const section = { open: state.shouldOpen(forced) };

  return {
    section,
    toggle(open: boolean) {
      section.open = open;
      state.recordToggle(section.open, forced);
    },
  };
}

describe("memory history open state", () => {
  it("is collapsed on first render", () => {
    expect(render(new MemoryHistoryOpen(), false).section.open).toBe(false);
  });

  it("forces open while a history row is being forgotten, even if the user never opened it", () => {
    const state = new MemoryHistoryOpen();
    expect(render(state, true).section.open).toBe(true);
    // the forced render must not turn into the user's choice
    const forced = render(state, true);
    forced.toggle(true);
    expect(render(state, false).section.open).toBe(false);
  });

  it("keeps the section open across re-renders once the user opened it, and closed after they close it", () => {
    const state = new MemoryHistoryOpen();
    render(state, false).toggle(true);
    expect(render(state, false).section.open).toBe(true);
    expect(render(state, true).section.open).toBe(true);
    render(state, false).toggle(false);
    expect(render(state, false).section.open).toBe(false);
  });

  it("reset returns to collapsed", () => {
    const state = new MemoryHistoryOpen();
    render(state, false).toggle(true);
    state.reset();
    expect(render(state, false).section.open).toBe(false);
  });
});
