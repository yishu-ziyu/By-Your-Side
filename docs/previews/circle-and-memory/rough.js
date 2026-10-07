"use strict";
var Rough = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // extension/src/shared/rough/index.ts
  var index_exports = {};
  __export(index_exports, {
    boilPass: () => boilPass,
    doubleStroke: () => doubleStroke,
    ellipsePoints: () => ellipsePoints,
    jitter: () => jitter,
    mulberry32: () => mulberry32,
    roughArrow: () => roughArrow,
    roughEllipse: () => roughEllipse,
    sampleLine: () => sampleLine,
    sketchFrame: () => sketchFrame,
    sketchLabelPosition: () => sketchLabelPosition,
    toPath: () => toPath
  });

  // extension/src/shared/rough/prng.ts
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // extension/src/shared/rough/geometry.ts
  function sampleLine(x1, y1, x2, y2, step = 8) {
    const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
    return Array.from({ length: n + 1 }, (_, i) => [
      x1 + (x2 - x1) * i / n,
      y1 + (y2 - y1) * i / n
    ]);
  }
  function ellipsePoints(cx, cy, rx, ry, a0, a1, n) {
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + (a1 - a0) * i / n;
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });
  }
  function jitter(points, rand, amp) {
    return points.map(([x, y]) => [x + (rand() * 2 - 1) * amp, y + (rand() * 2 - 1) * amp]);
  }
  function toPath(points, close) {
    const first = points[0];
    if (!first) return "";
    let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const pCurrent = points[i];
      const pNext = points[i + 1];
      if (!pCurrent || !pNext) continue;
      const [cx, cy] = pCurrent;
      const mx = (cx + pNext[0]) / 2;
      const my = (cy + pNext[1]) / 2;
      d += ` Q${cx.toFixed(2)} ${cy.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
    }
    const last = points[points.length - 1];
    if (last) {
      d += ` L${last[0].toFixed(2)} ${last[1].toFixed(2)}`;
    }
    return close ? d + " Z" : d;
  }
  function boilPass(points, o) {
    if (!o.boil || o.boilSeed === void 0) return points;
    return jitter(points, mulberry32(o.boilSeed), o.boil);
  }
  function doubleStroke(points, o, close) {
    const rand = mulberry32(o.seed);
    const amp = 1.4 * o.roughness;
    return toPath(boilPass(jitter(points, rand, amp), o), close) + " " + toPath(boilPass(jitter(points, rand, amp * 1.3), o), close);
  }
  function roughEllipse(cx, cy, rx, ry, o) {
    const h = ((rx - ry) / (rx + ry)) ** 2;
    const perimeter = Math.PI * (rx + ry) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
    const n = Math.max(8, Math.ceil(perimeter / 8));
    return doubleStroke(ellipsePoints(cx, cy, rx, ry, 0, Math.PI * 2, n).slice(0, -1), o, true);
  }
  function roughArrow(x1, y1, x2, y2, o) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    const headLen = 10;
    const headAngle = Math.PI / 6;
    const wing = (da) => [
      x2 - headLen * Math.cos(a + da),
      y2 - headLen * Math.sin(a + da)
    ];
    const [lx, ly] = wing(headAngle);
    const [rx, ry] = wing(-headAngle);
    const rand = mulberry32(o.seed);
    const amp = 1.2 * o.roughness;
    const head = (px, py) => toPath(boilPass(jitter(sampleLine(x2, y2, px, py, 3), rand, amp), o), false);
    const shaft = doubleStroke(sampleLine(x1, y1, x2, y2, 6), o, false);
    return shaft + " " + head(lx, ly) + " " + head(rx, ry);
  }

  // extension/src/shared/rough/frame.ts
  var WIDE_RATIO = 3.2;
  function roundedRectPoints(b, r) {
    const n = 5;
    const { x, y, w, h } = b;
    return [
      ...sampleLine(x + r, y, x + w - r, y),
      ...ellipsePoints(x + w - r, y + r, r, r, -Math.PI / 2, 0, n),
      ...sampleLine(x + w, y + r, x + w, y + h - r),
      ...ellipsePoints(x + w - r, y + h - r, r, r, 0, Math.PI / 2, n),
      ...sampleLine(x + w - r, y + h, x + r, y + h),
      ...ellipsePoints(x + r, y + h - r, r, r, Math.PI / 2, Math.PI, n),
      ...sampleLine(x, y + h - r, x, y + r),
      ...ellipsePoints(x + r, y + r, r, r, Math.PI, Math.PI * 1.5, n)
    ];
  }
  function sketchFrame(target, o) {
    const rand = mulberry32(o.seed);
    const amp = 1.1 * o.roughness;
    if (target.w / Math.max(1, target.h) > WIDE_RATIO) {
      const pad = 4;
      const frame = { x: target.x - pad, y: target.y - pad, w: target.w + pad * 2, h: target.h + pad * 2 };
      return { d: toPath(boilPass(jitter(roundedRectPoints(frame, Math.min(10, frame.h / 2)), rand, amp), o), true), frame };
    }
    const cx = target.x + target.w / 2;
    const cy = target.y + target.h / 2;
    const rx = target.w / 2 * 1.25 + 4;
    const ry = target.h / 2 * 1.25 + 4;
    const n = Math.max(24, Math.ceil(Math.PI * (rx + ry) / 8));
    return { d: toPath(boilPass(jitter(ellipsePoints(cx, cy, rx, ry, 0, Math.PI * 2, n).slice(0, -1), rand, amp), o), true), frame: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 } };
  }
  function sketchLabelPosition(frame, label, room) {
    const gap = 8;
    const above = frame.y - label.h - 2;
    const below = frame.y + frame.h + 2;
    const right = { left: frame.x + frame.w + gap, top: frame.y + frame.h / 2 - label.h / 2 };
    const candidates = [right, { left: frame.x, top: above }, { left: frame.x, top: below }, { left: frame.x - gap - label.w, top: right.top }];
    for (let dx = 16; dx <= 480; dx += 16) candidates.push({ left: frame.x + dx, top: above }, { left: frame.x + dx, top: below });
    const boxOf = (c) => ({ x: c.left, y: c.top, w: label.w, h: label.h });
    const visible = candidates.filter((c) => room.inView(boxOf(c)));
    return visible.find((c) => room.clear(boxOf(c))) ?? visible[0] ?? right;
  }
  return __toCommonJS(index_exports);
})();
