#!/usr/bin/env python3
"""Rounder M bodies × eye cuts. Inspect, then pick."""

from pathlib import Path
import cairo
import math

OUT = Path("/Users/mahaoxuan/Desktop/ego/docs/evals/assets/reicon-m")
FILL = (155 / 255, 138 / 255, 251 / 255, 1)


def new_surf(size=300):
    s = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    ctx = cairo.Context(s)
    ctx.scale(size / 150, size / 150)
    ctx.set_source_rgba(*FILL)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    return s, ctx


def punch(ctx, eyes):
    ctx.set_operator(cairo.OPERATOR_CLEAR)
    for cx, cy, rx, ry in eyes:
        ctx.save()
        ctx.translate(cx, cy)
        ctx.scale(rx, ry)
        ctx.arc(0, 0, 1, 0, math.tau)
        ctx.fill()
        ctx.restore()


def stroke_sharp(ctx, w=44):
    ctx.set_line_width(w)
    ctx.move_to(30, 128)
    ctx.line_to(30, 22)
    ctx.line_to(75, 86)
    ctx.line_to(120, 22)
    ctx.line_to(120, 128)
    ctx.stroke()


def stroke_curve_v(ctx, w=46):
    """Capital M, V is a curve not a point."""
    ctx.set_line_width(w)
    ctx.move_to(32, 126)
    ctx.line_to(32, 30)
    ctx.curve_to(32, 12, 46, 10, 56, 26)
    ctx.curve_to(64, 40, 70, 62, 75, 72)
    ctx.curve_to(80, 62, 86, 40, 94, 26)
    ctx.curve_to(104, 10, 118, 12, 118, 30)
    ctx.line_to(118, 126)
    ctx.stroke()


def stroke_puff(ctx, w=50):
    """Fatter, peaks closer, shallower valley — closer to R blob."""
    ctx.set_line_width(w)
    ctx.move_to(36, 122)
    ctx.line_to(36, 42)
    ctx.curve_to(36, 14, 54, 10, 64, 32)
    ctx.curve_to(70, 46, 72, 58, 75, 64)
    ctx.curve_to(78, 58, 80, 46, 86, 32)
    ctx.curve_to(96, 10, 114, 14, 114, 42)
    ctx.line_to(114, 122)
    ctx.stroke()


def stroke_soft_join(ctx, w=48):
    """Two stems + a rounded valley bar so the crotch is a marshmallow, not a spike."""
    ctx.set_line_width(w)
    ctx.move_to(34, 124)
    ctx.line_to(34, 28)
    ctx.curve_to(34, 10, 50, 8, 60, 24)
    ctx.line_to(68, 48)
    ctx.move_to(116, 124)
    ctx.line_to(116, 28)
    ctx.curve_to(116, 10, 100, 8, 90, 24)
    ctx.line_to(82, 48)
    ctx.stroke()
    # soft valley connector
    ctx.set_line_width(w * 0.92)
    ctx.move_to(60, 36)
    ctx.curve_to(66, 58, 84, 58, 90, 36)
    ctx.stroke()


def blob_filled(ctx):
    """Single filled silhouette: two rounded peaks, soft V, two chubby feet, slight bottom arch."""
    ctx.set_line_width(0)
    ctx.move_to(28, 138)
    ctx.curve_to(12, 138, 10, 118, 12, 96)
    ctx.curve_to(14, 60, 16, 36, 28, 20)
    ctx.curve_to(38, 8, 52, 8, 62, 20)
    ctx.curve_to(68, 28, 72, 40, 75, 48)
    ctx.curve_to(78, 40, 82, 28, 88, 20)
    ctx.curve_to(98, 8, 112, 8, 122, 20)
    ctx.curve_to(134, 36, 136, 60, 138, 96)
    ctx.curve_to(140, 118, 138, 138, 122, 138)
    ctx.curve_to(110, 138, 104, 126, 102, 112)
    ctx.curve_to(100, 100, 90, 92, 75, 92)
    ctx.curve_to(60, 92, 50, 100, 48, 112)
    ctx.curve_to(46, 126, 40, 138, 28, 138)
    ctx.close_path()
    ctx.fill()


def blob_m_tight(ctx):
    """Tighter M: deeper V than blob_filled, still G2-round, two feet."""
    ctx.move_to(26, 140)
    ctx.curve_to(10, 140, 8, 122, 10, 98)
    ctx.curve_to(12, 58, 14, 32, 26, 16)
    ctx.curve_to(36, 4, 50, 6, 58, 18)
    ctx.curve_to(64, 28, 70, 48, 75, 58)
    ctx.curve_to(80, 48, 86, 28, 92, 18)
    ctx.curve_to(100, 6, 114, 4, 124, 16)
    ctx.curve_to(136, 32, 138, 58, 140, 98)
    ctx.curve_to(142, 122, 140, 140, 124, 140)
    ctx.curve_to(112, 140, 106, 128, 104, 114)
    ctx.curve_to(102, 98, 92, 88, 75, 88)
    ctx.curve_to(58, 88, 48, 98, 46, 114)
    ctx.curve_to(44, 128, 38, 140, 26, 140)
    ctx.close_path()
    ctx.fill()


# Eye recipes, in 150 box
EYES = {
    "capsule": [(46, 48, 8.5, 17), (104, 48, 8.5, 17)],
    "round": [(46, 50, 11, 13), (104, 50, 11, 13)],
    "tall": [(46, 46, 7, 19), (104, 46, 7, 19)],
    "close": [(52, 48, 8.5, 17), (98, 48, 8.5, 17)],
    "low": [(46, 58, 8.5, 16), (104, 58, 8.5, 16)],
    "reicon": [(50, 50, 9.5, 19), (100, 50, 9.5, 19)],  # larger, a bit closer
}


BODIES = {
    "0-now": stroke_sharp,
    "1-curveV": stroke_curve_v,
    "2-puff": stroke_puff,
    "3-softJoin": stroke_soft_join,
    "4-blob": blob_filled,
    "5-tight": blob_m_tight,
}


def render(body_name, eye_name, size=300):
    s, ctx = new_surf(size)
    BODIES[body_name](ctx)
    punch(ctx, EYES[eye_name])
    path = OUT / f"lb-{body_name}-{eye_name}.png"
    s.write_to_png(str(path))
    return path


def contact_sheet():
    bodies = list(BODIES)
    eyes = list(EYES)
    cell, pad, label_h = 180, 16, 22
    cols, rows = len(eyes), len(bodies)
    W = pad + cols * (cell + pad)
    H = pad + rows * (cell + label_h + pad)
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx = cairo.Context(surf)
    ctx.set_source_rgb(0.07, 0.07, 0.08)
    ctx.paint()
    ctx.select_font_face("Helvetica", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    for r, b in enumerate(bodies):
        for c, e in enumerate(eyes):
            tile = cairo.ImageSurface.create_from_png(str(OUT / f"lb-{b}-{e}.png"))
            x = pad + c * (cell + pad)
            y = pad + r * (cell + label_h + pad)
            ctx.save()
            ctx.translate(x, y)
            ctx.scale(cell / 300, cell / 300)
            ctx.set_source_surface(tile, 0, 0)
            ctx.paint()
            ctx.restore()
            ctx.set_source_rgb(0.85, 0.85, 0.88)
            ctx.set_font_size(11)
            ctx.move_to(x, y + cell + 14)
            ctx.show_text(f"{b} · {e}")
    # header row already labeled per cell
    out = OUT / "lookbook.png"
    surf.write_to_png(str(out))
    print("wrote", out, W, H)


def main():
    for b in BODIES:
        for e in EYES:
            render(b, e, 300)
            render(b, e, 72) if False else None
            # also 36px-display 72px file for recommended later
    # 72px for each
    for b in BODIES:
        for e in EYES:
            s, ctx = new_surf(72)
            BODIES[b](ctx)
            punch(ctx, EYES[e])
            s.write_to_png(str(OUT / f"lb-{b}-{e}-36.png"))
    contact_sheet()
    print("done")


if __name__ == "__main__":
    main()
