import { describe, expect, it } from "vitest";
import {
  PAW_OVERLAP,
  RIM_GAP,
  SPRITE_W,
  composerIdleAnchor,
  isLongMessage,
  mascotSvg,
  overlapsContent,
  rimAnchor,
  topRimAnchor,
  type Box,
} from "../src/sidepanel/companion.js";

const app = { top: 0, left: 0 };
const box = (top: number, left: number, width: number, height: number): Box => ({
  top,
  left,
  right: left + width,
  width,
  height,
});

describe("companion rim geometry", () => {
  it("idle perch sits above the composer by RIM_GAP and to the right of the page pill", () => {
    const composer = box(400, 12, 336, 120);
    const pill = box(410, 22, 140, 22);
    const pos = composerIdleAnchor(composer, app, pill);
    expect(pos.top).toBe(400 - RIM_GAP);
    expect(pos.left).toBeGreaterThanOrEqual(pill.right + 6);
    expect(pos.left + SPRITE_W).toBeLessThanOrEqual(composer.right - 8);
  });

  it("idle perch stays on the composer when there is no pill", () => {
    const composer = box(400, 12, 336, 120);
    const pos = composerIdleAnchor(composer, app, null);
    expect(pos.top).toBe(400 - RIM_GAP);
    expect(pos.left).toBe(12 + 22);
  });

  it("bubble perch stays outside the text inset of a user bubble", () => {
    const bubble = box(80, 40, 200, 48);
    const pos = rimAnchor(bubble, app, "bubble");
    const actor = box(pos.top, pos.left, SPRITE_W, 36);
    expect(actor.top + actor.height - bubble.top).toBeLessThanOrEqual(PAW_OVERLAP + 2);
    expect(overlapsContent(actor, bubble, 8)).toBe(false);
  });

  it("step perch sits on the card top-left rim, not on the title", () => {
    const card = box(160, 14, 320, 180);
    const pos = rimAnchor(card, app, "step");
    const actor = box(pos.top, pos.left, SPRITE_W, 36);
    expect(pos.top).toBe(160 - RIM_GAP);
    expect(pos.left).toBe(card.left + 10);
    expect(overlapsContent(actor, card, 8)).toBe(false);
  });

  it("clamps below the topbar when the target is too high", () => {
    const bubble = box(48, 160, 180, 40);
    const pos = rimAnchor(bubble, app, "bubble", { minTop: 44, minLeft: 8, maxLeft: 320 });
    expect(pos.top).toBeGreaterThanOrEqual(44);
    expect(pos.left + SPRITE_W).toBeLessThanOrEqual(bubble.left);
  });

  it("walks the top rim without entering the card inset", () => {
    const card = box(120, 20, 280, 80);
    const start = topRimAnchor(card, app, 0);
    const end = topRimAnchor(card, app, 1);
    expect(start.left).toBe(card.left + 8);
    expect(end.left).toBe(card.right - SPRITE_W - 8);
    expect(overlapsContent(box(start.top, start.left, SPRITE_W, 36), card, 8)).toBe(false);
    expect(overlapsContent(box(end.top, end.left, SPRITE_W, 36), card, 8)).toBe(false);
  });
});

describe("companion message reactions", () => {
  it("treats short chat as a nod, long chat as surprise", () => {
    expect(isLongMessage("今天下午有空吗？")).toBe(false);
    expect(
      isLongMessage(
        "帮我把今天下午到晚上的安排理一遍：两点的评审、四点的电话、晚上可能要改一版日历说明。",
      ),
    ).toBe(true);
  });

  it("renders a single-path M with punched eyes, not collage features", () => {
    const svg = mascotSvg("test-eyes");
    expect(svg).toContain("stroke-linejoin=\"round\"");
    expect(svg).toContain("mask id=\"test-eyes\"");
    expect(svg).not.toContain("circle");
    expect(svg).not.toContain("ear");
  });
});
