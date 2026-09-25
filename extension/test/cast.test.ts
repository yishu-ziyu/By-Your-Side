import { describe, expect, it } from "vitest";
import { assignedWorkerId, displayColor, displayNameFor, personFor } from "../../shared/cast.js";
import { cursorColor } from "../src/shared/palette.js";
import { describeTool } from "../src/sidepanel/steps.js";

describe("名册", () => {
  it("Lead 不是名册上的人", () => {
    expect(personFor("main")).toBeNull();
    expect(displayNameFor("main")).toBe("By Your Side");
    expect(displayColor("main")).toBe("#2d4a86");
    expect(cursorColor("main")).toBe("#2d4a86");
  });

  it("同一 id 总是同一个人", () => {
    expect(personFor("flomo")?.name).toBe(personFor("flomo")?.name);
    expect(cursorColor("flomo")).toBe(personFor("flomo")?.color);
  });

  it("常见双站任务分到不同的人", () => {
    expect(personFor("flomo")?.name).not.toBe(personFor("bilibili")?.name);
  });


});

describe("界面文案不含工人", () => {
  it("spawn/stop/post 描述没有「工人」", () => {
    for (const id of ["wiki", "flomo", "bilibili"]) {
      expect(describeTool("spawn_worker", { id }).full).not.toMatch(/工人/);
      expect(describeTool("stop_worker", { id }).full).not.toMatch(/工人/);
    }

    expect(describeTool("list_workers", {}).full).not.toMatch(/工人/);
  });
});


describe("运行身份分配", () => {
  it("同样的请求名并行创建时分配不同角色，光标和历史读取一致", () => {
    const a = assignedWorkerId("reader", "abcdef01", []);
    const b = assignedWorkerId("reader", "abcdef02", [a]);
    expect(personFor(a)?.key).not.toBe(personFor(b)?.key);

    for (const id of [a, b]) {
      expect(cursorColor(id)).toBe(personFor(id)?.color);
      expect(displayNameFor(JSON.parse(JSON.stringify(id)))).toBe(personFor(id)?.name);
    }
  });
  it("旧会话仍按旧散列显示；新会话不受随机后缀影响", () => {
    expect(displayNameFor("a-cbb6b6e5")).toBe("Gus");
    expect(displayNameFor("b-d0df6c9f")).toBe("Gus");
    expect(displayNameFor(assignedWorkerId("a", "abcdef01", [])))
      .toBe(displayNameFor(assignedWorkerId("a", "12345678", [])));
    expect(describeTool("spawn_worker", { id: "a" }).full).toBe("安排助手");
  });
});
