import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GUIDE_ARROW_CURVE_PX,
  GUIDE_DRAW_MS,
  GUIDE_ROUGHNESS,
  GUIDE_SPOTLIGHT_ALPHA,
  placeGuideBubble,
  sketchArrow,
  type RectBox,
} from "../extension/src/shared/rough/arrow.js";

function overlap(a: RectBox, b: RectBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  return x * y;
}

describe("live tutor arrow and non-hiding bubble placement", () => {
  it("locks user-confirmed tuning parameters", () => {
    assert.equal(GUIDE_SPOTLIGHT_ALPHA, 0.13);
    assert.equal(GUIDE_DRAW_MS, 360);
    assert.equal(GUIDE_ARROW_CURVE_PX, 26);
    assert.equal(GUIDE_ROUGHNESS, 0.9);
  });

  it("never hides or clips bubble on a crowded top-right button", () => {
    const viewport: RectBox = { x: 0, y: 0, w: 1280, h: 760 };
    const target: RectBox = { x: 1120, y: 12, w: 144, h: 32 };
    const obstacles: RectBox[] = [
      { x: 1030, y: 12, w: 80, h: 32 },
      { x: 940, y: 12, w: 80, h: 32 },
      { x: 24, y: 76, w: 220, h: 28 },
    ];
    const bubble = { w: 264, h: 72 };
    const placed = placeGuideBubble(target, bubble, viewport, obstacles, { cursorPoint: { x: 1258, y: 38 } });

    assert.ok(placed.box.x >= 12 && placed.box.x + placed.box.w <= viewport.w - 12);
    assert.ok(placed.box.y >= 12 && placed.box.y + placed.box.h <= viewport.h - 12);
    assert.equal(overlap(placed.box, target), 0);

    const arrow = sketchArrow(placed.box, target, { seed: 303 });
    assert.ok(arrow !== null);
    assert.ok(arrow.shaft.startsWith("M"));
    assert.ok(arrow.head.startsWith("M"));
    assert.ok(!arrow.shaft.includes("NaN") && !arrow.head.includes("NaN"));
  });

  it("produces deterministic curved arrows across 8 relative placements", () => {
    const target: RectBox = { x: 500, y: 340, w: 110, h: 36 };
    const offsets: Array<[number, number]> = [
      [-260, -140], [0, -140], [220, -140],
      [-280, 0], [230, 0],
      [-260, 120], [0, 120], [220, 120],
    ];

    for (const [dx, dy] of offsets) {
      const bubble: RectBox = { x: target.x + dx, y: target.y + dy, w: 220, h: 64 };
      const first = sketchArrow(bubble, target, { seed: 42 });
      const second = sketchArrow(bubble, target, { seed: 42 });
      assert.ok(first !== null);
      assert.deepEqual(first, second);
      assert.ok(Math.hypot(first.end.x - first.start.x, first.end.y - first.start.y) >= 14);
      assert.equal(overlap({ x: first.end.x - 1, y: first.end.y - 1, w: 2, h: 2 }, target), 0);
    }
  });

  it("stays inside narrow mobile viewports without NaN or hiding", () => {
    const viewport: RectBox = { x: 0, y: 0, w: 390, h: 680 };
    const target: RectBox = { x: 250, y: 18, w: 120, h: 34 };
    const placed = placeGuideBubble(target, { w: 260, h: 74 }, viewport, [{ x: 16, y: 72, w: 240, h: 30 }]);

    assert.ok(Number.isFinite(placed.left) && Number.isFinite(placed.top));
    assert.ok(placed.box.x >= 12 && placed.box.x + placed.box.w <= viewport.w - 12);
    assert.ok(placed.box.y >= 12 && placed.box.y + placed.box.h <= viewport.h - 12);
  });
});
