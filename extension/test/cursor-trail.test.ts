import { describe, expect, it } from "vitest";
import {
  appendTrail,
  documentPoint,
  isReplayRequest,
  pointsOnTab,
  viewportPoint,
} from "../src/shared/cursor-trail.js";
import { commitTrail, recordTrailPoint, resetTrailsForTests, trailForReplay } from "../src/background/exec/trail.js";

describe("isReplayRequest", () => {
  it("短句里出现回放就算请再演一遍", () => {
    expect(isReplayRequest("回放")).toBe(true);
    expect(isReplayRequest("回放一下刚才的操作")).toBe(true);
    expect(isReplayRequest("你可以把刚才那个操作回放一下吗")).toBe(true);
    expect(isReplayRequest("replay")).toBe(true);
    expect(isReplayRequest("把刚才的操作再看一遍")).toBe(true);
  });

  it("普通任务不是回放", () => {
    expect(isReplayRequest("把这条笔记删掉")).toBe(false);
    expect(isReplayRequest("打开 flomo")).toBe(false);
    expect(isReplayRequest("")).toBe(false);
  });
});

describe("trail points", () => {
  it("视口加滚动得到文档坐标，回放时再减回去", () => {
    const doc = documentPoint(90, 148, 0, 200);
    expect(doc).toEqual({ x: 90, y: 348 });
    expect(viewportPoint(doc.x, doc.y, 0, 200)).toEqual({ x: 90, y: 148 });
  });

  it("超过上限丢掉最早的点", () => {
    let pts: ReturnType<typeof appendTrail> = [];
    for (let i = 0; i < 42; i++) {
      pts = appendTrail(pts, { tabId: 1, x: i, y: 0, click: true }, 40);
    }
    expect(pts).toHaveLength(40);
    expect(pts[0]?.x).toBe(2);
    expect(pts[39]?.x).toBe(41);
  });

  it("回放只用同一个标签页上的点", () => {
    const trail = {
      tabId: 8,
      sessionId: "main",
      points: [
        { tabId: 7, x: 1, y: 1, click: true },
        { tabId: 8, x: 2, y: 2, click: true },
        { tabId: 8, x: 3, y: 3, click: false },
      ],
    };
    expect(pointsOnTab(trail, 8)).toHaveLength(2);
  });
});

describe("trail store", () => {
  it("任务结束后留下上一轮，供回放", () => {
    resetTrailsForTests();
    recordTrailPoint("main", { tabId: 3, x: 10, y: 20, click: true });
    recordTrailPoint("main", { tabId: 3, x: 40, y: 80, click: true });
    expect(trailForReplay()?.points).toHaveLength(2);
    commitTrail("main");
    expect(trailForReplay()?.points).toHaveLength(2);
    recordTrailPoint("main", { tabId: 3, x: 1, y: 1, click: true });
    commitTrail("main");
    expect(trailForReplay()?.points).toEqual([{ tabId: 3, x: 1, y: 1, click: true }]);
  });
});
