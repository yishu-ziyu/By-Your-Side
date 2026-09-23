import { expect, it } from "vitest";
import { collectDecisionControls, selectObservationView } from "../src/background/browser-observation.js";
import type { AxNodeLite } from "../src/background/axtree.js";

// A three-control hover menu must not require a region-selection round. This
// reproduces S5's observed trigger-only view after the real menu became visible.
it("a complete small page exposes all observed controls without forced partitioning", () => {
  const collected = [
    { ref: "@1", role: "generic", name: "Account", disabled: false, scopeId: "outer" },
    { ref: "@2", role: "menuitem", name: "Settings", disabled: false, scopeId: "menu" },
    { ref: "@3", role: "menuitem", name: "Forbidden", disabled: false, scopeId: "menu" },
  ];

  const view = selectObservationView({ collected, tabs: [], collectionComplete: true, generation: "small", textTruncated: false });
  expect(view.controls.map(c => c.ref)).toEqual(["@1", "@2", "@3"]);
  expect(view.hasMore).toBe(false);
  expect(view.nextCursor).toBeUndefined();
});

it("a supported focusable generic does not falsely mark a complete AX collection incomplete", () => {
  const nodes: AxNodeLite[] = [
    { nodeId: "g", backendDOMNodeId: 1, role: { value: "generic" }, name: { value: "Account" }, properties: [{ name: "focusable", value: { value: true } }] },
    { nodeId: "a", parentId: "g", backendDOMNodeId: 2, role: { value: "menuitem" }, name: { value: "Settings" } },
    { nodeId: "b", parentId: "g", backendDOMNodeId: 3, role: { value: "menuitem" }, name: { value: "Forbidden" } },
  ];

  const result = collectDecisionControls(nodes);
  expect(result.controls.map(c => c.ref)).toEqual(["@1", "@2", "@3"]);
  expect(result.collectionComplete).toBe(true);
  expect(result.collectionLimitReached).toBe(false);
});
