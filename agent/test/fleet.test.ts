import { describe, expect, it } from "vitest";
import { MAX_WORKERS, assertCanSpawn, sanitizeWorkerId } from "../src/fleet.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";

describe("sanitizeWorkerId", () => {
  it("保留短小写字母数字，拒绝 main", () => {
    expect(sanitizeWorkerId("Wiki", [])).toBe("wiki");
    expect(sanitizeWorkerId("main", [])).toBe("worker");
    expect(sanitizeWorkerId("  Feishu_Doc  ", [])).toBe("feishu_doc");
  });

  it("非法字符剥离，空则 worker", () => {
    expect(sanitizeWorkerId("***", [])).toBe("worker");
    expect(sanitizeWorkerId(undefined, [])).toBe("worker");
  });

  it("冲突时加后缀", () => {
    expect(sanitizeWorkerId("wiki", ["wiki"])).toBe("wiki-2");
    expect(sanitizeWorkerId("wiki", ["wiki", "wiki-2"])).toBe("wiki-3");
  });

  it("不会等于 lead id", () => {
    expect(sanitizeWorkerId(LEAD_SESSION_ID, [])).not.toBe(LEAD_SESSION_ID);
  });
});

describe("assertCanSpawn", () => {
  it("未满员放行，满员抛错", () => {
    expect(() => assertCanSpawn(0)).not.toThrow();
    expect(() => assertCanSpawn(MAX_WORKERS - 1)).not.toThrow();
    expect(() => assertCanSpawn(MAX_WORKERS)).toThrow(/最多同时请 2/);
  });
});
