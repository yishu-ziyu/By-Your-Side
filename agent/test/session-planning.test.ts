import { it, expect } from "vitest";
import { SYSTEM_PROMPT, workerSystemPrompt } from "../src/prompt.js";
it("planning is structural and communicates useful decomposition before spawning", () => {
  expect(SYSTEM_PROMPT).toContain("dependencies, transferable artifacts, shared live state, and coordination cost");
  expect(SYSTEM_PROMPT).toContain("Before spawn_worker, tell the user");
  expect(SYSTEM_PROMPT).toContain("never a fixed pair");
  expect(SYSTEM_PROMPT).toContain("Do NOT spawn for a short single-field edit");
  expect(SYSTEM_PROMPT).toContain("sharedTabId");
  expect(SYSTEM_PROMPT).toContain("page_operation");
  const parallelStart = SYSTEM_PROMPT.indexOf("# Parallel workers");
  const nextHeading = SYSTEM_PROMPT.indexOf("\n# ", parallelStart + 1);
  const parallelSection = SYSTEM_PROMPT.slice(parallelStart, nextHeading < 0 ? undefined : nextHeading);
  expect(parallelSection).not.toMatch(/resume|education|employment|简历|教育经历|工作经历/i);
  const worker = workerSystemPrompt({ id: "writer", peers: [], tabId: 2 });
  expect(worker).toContain("expected current value");
  expect(worker).toContain("Do not navigate, submit or save the shared page");
});
