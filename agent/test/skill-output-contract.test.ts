import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeDeliverableContract } from "../src/skill-output-contract.js";

vi.mock("../src/typesafe-auth.js", () => ({ readTypeSafeKey: () => "test-key" }));

afterEach(() => vi.unstubAllGlobals());

describe("learning judgment response boundary", () => {
  it.each([1.01, 2, -.01, "0.99", null])("rejects malformed probability %s rather than authorizing reuse", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ answers: { workflow_only: { noul: value } } }) })));
    await expect(judgeDeliverableContract({ request: "查询", actions: ["查询"] })).rejects.toThrow("未返回可用的判断");
  });
  it("preserves a valid probability without changing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ answers: { workflow_only: { noul: .83 } } }) })));
    await expect(judgeDeliverableContract({ request: "查询", actions: ["查询"] })).resolves.toBe(.83);
  });
});
