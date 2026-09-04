import { describe, expect, it } from "vitest";
import { CAST, displayColor, displayNameFor, personFor } from "../../shared/cast.js";
import { cursorColor } from "../src/shared/palette.js";
import { lerpExpr } from "../src/shared/grok-bot.js";
import { GROKBOT_ORIGINAL } from "../src/shared/grok-original.js";
import { describeTool } from "../src/sidepanel/steps.js";

describe("名册", () => {
  it("Lead 不是名册上的人", () => {
    expect(personFor("main")).toBeNull();
    expect(displayNameFor("main")).toBe("SideAgent");
    expect(displayColor("main")).toBe("#2f6fed");
    expect(cursorColor("main")).toBe("#2f6fed");
  });

  it("同一 id 总是同一个人", () => {
    expect(personFor("flomo")?.name).toBe(personFor("flomo")?.name);
    expect(cursorColor("flomo")).toBe(personFor("flomo")?.color);
  });

  it("常见双站任务分到不同的人", () => {
    expect(personFor("flomo")?.name).not.toBe(personFor("bilibili")?.name);
  });

  it("Mike 有 Kenney 等待脸，Omar 常驻紫菱", () => {
    const mike = CAST.find((p) => p.key === "mike");
    expect(mike?.kenneyWait?.face).toBe("face_b.png");
    expect(mike?.waitLine).toBe("还没到");
    const omar = CAST.find((p) => p.key === "omar");
    expect(omar?.kenney?.body).toBe("purple_body_rhombus.png");
    expect(omar?.kenney?.face).toBe("face_h.png");
  });

  it("律师和火线都在名册里", () => {
    expect(CAST.filter((p) => p.crew === "bcs").map((p) => p.name)).toEqual(["Kim", "Mike", "Lalo", "Gus"]);
    expect(CAST.filter((p) => p.crew === "wire").map((p) => p.name)).toEqual(["Kima", "Omar", "Bunk", "Lester"]);
  });
});

describe("Grok Bot 表情数据", () => {
  it("25 套眼，插值从起点到终点", () => {
    expect(GROKBOT_ORIGINAL.EXPRESSIONS.length).toBe(25);
    const a = GROKBOT_ORIGINAL.EXPRESSIONS[0]!;
    const b = GROKBOT_ORIGINAL.EXPRESSIONS[2]!;
    const mid = lerpExpr(a, b, 0.5);
    expect(mid[0]?.[0]?.[0]).toBeCloseTo(((a[0]?.[0]?.[0] ?? 0) + (b[0]?.[0]?.[0] ?? 0)) / 2, 5);
    expect(lerpExpr(a, b, 0)[0]?.[0]).toEqual(a[0]?.[0]);
    expect(lerpExpr(a, b, 1)[0]?.[0]).toEqual(b[0]?.[0]);
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
