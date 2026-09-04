import { describe, expect, it } from "vitest";
import { CURSOR_PALETTE, CURSOR_STROKE_HALO, CURSOR_STROKE_WHITE, CURSOR_SVG_SIZE, cursorColor } from "../src/shared/cursor-visual.js";
import {
  HIGHLIGHT_PAD,
  MARK_PAD,
  OVERLAY_ATTR,
  highlightBounds,
  overlayHostSelector,
  sweepStaleOverlayHosts,
  viewportRectToDocumentBox,
} from "../src/shared/overlay.js";

describe("overlay host sweep（扩展 reload 残留）", () => {
  it("选择器按 data-sideagent-overlay 标识 host", () => {
    expect(overlayHostSelector()).toBe(`[${OVERLAY_ATTR}]`);
  });

  it("启动清扫移除全部 overlay host，不影响其它节点", () => {
    const removed: string[] = [];
    const keep = { id: "keep", remove: () => removed.push("keep") };
    const cursorHost = { id: "cursor", remove: () => removed.push("cursor") };
    const marksHost = { id: "marks", remove: () => removed.push("marks") };
    const root = {
      querySelectorAll(sel: string) {
        expect(sel).toBe(`[${OVERLAY_ATTR}]`);
        return [cursorHost, marksHost];
      },
    };
    expect(sweepStaleOverlayHosts(root)).toBe(2);
    expect(removed).toEqual(["cursor", "marks"]);
    expect(keep.id).toBe("keep");
  });

  it("页面上没有旧 host 时返回 0", () => {
    expect(sweepStaleOverlayHosts({ querySelectorAll: () => [] })).toBe(0);
  });
});

describe("highlight / mark 几何", () => {
  it("计算高亮外扩包围盒（含 pad 边界与取整）", () => {
    const rect = { x: 100.4, y: 50.2, width: 200, height: 40 };
    expect(highlightBounds(rect, HIGHLIGHT_PAD)).toEqual({
      left: 97,
      top: 47,
      width: 206,
      height: 46,
    });
  });

  it("拒绝零尺寸或负尺寸元素的无效高亮/标注", () => {
    expect(highlightBounds({ x: 10, y: 10, width: 0, height: 20 })).toBeNull();
    expect(viewportRectToDocumentBox({ x: 10, y: 10, width: 20, height: 0 }, 0, 0)).toBeNull();
    expect(highlightBounds({ x: 10, y: 10, width: -5, height: 20 })).toBeNull();
  });

  it("视口坐标转文档坐标：加上滚动偏移并外扩 pad", () => {
    const box = viewportRectToDocumentBox({ x: 40, y: 80, width: 120, height: 30 }, 10, 200, MARK_PAD);
    expect(box).toEqual({ x: 44, y: 274, width: 132, height: 42 });
  });

  it("resize 后用新的视口包围盒重算，不沿用旧快照", () => {
    const before = viewportRectToDocumentBox({ x: 100, y: 50, width: 80, height: 20 }, 0, 0, MARK_PAD);
    const after = viewportRectToDocumentBox({ x: 180, y: 50, width: 80, height: 20 }, 0, 0, MARK_PAD);
    expect(before?.x).toBe(94);
    expect(after?.x).toBe(174);
    expect(after?.x).not.toBe(before?.x);
  });

  it("内部滚动：window.scroll 不变时文档坐标必须跟新的视口 y 走", () => {
    const before = viewportRectToDocumentBox({ x: 48, y: 200, width: 220, height: 48 }, 0, 0, MARK_PAD);
    const after = viewportRectToDocumentBox({ x: 48, y: 110, width: 220, height: 48 }, 0, 0, MARK_PAD);
    expect(before?.y).toBe(194);
    expect(after?.y).toBe(104);
    expect(before!.y - after!.y).toBe(90);
  });
});

describe("cursor visual / palette", () => {
  it("光标尺寸与描边大于旧版 27px/1.6，保证浅深底对比", () => {
    expect(CURSOR_SVG_SIZE).toBeGreaterThanOrEqual(36);
    expect(CURSOR_STROKE_WHITE).toBeGreaterThanOrEqual(2);
    expect(CURSOR_STROKE_HALO).toBeGreaterThan(CURSOR_STROKE_WHITE);
  });

  it("多实例调色板按序着色且主实例恒为品牌蓝", () => {
    expect(cursorColor("main", 0)).toBe("#2f6fed");
    expect(cursorColor("worker-1", 1)).toBe("#e2554f");
    expect(cursorColor("worker-2", 2)).toBe("#16a34a");
    expect(cursorColor("worker-3", 3)).toBe("#9333ea");
    expect(cursorColor("worker-4", 4)).toBe("#d97706");
    expect(cursorColor("worker-5", 5)).toBe("#2f6fed");
  });

  it("调色板 5 色互不相同（多实例区分度不劣化）", () => {
    expect(new Set(CURSOR_PALETTE).size).toBe(CURSOR_PALETTE.length);
  });
});
