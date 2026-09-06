#!/usr/bin/env python3
"""Build Reicon-style M mascots: real rounded-font letter + two punched eyes."""

from __future__ import annotations

from pathlib import Path

import cairosvg
from fontTools.misc.transform import Transform
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops, ImageOps

ROOT = Path("/Users/mahaoxuan/Desktop/ego/docs/evals/assets")
OUT = ROOT / "reicon-m"
OUT.mkdir(exist_ok=True)

FILL = "#9B8AFB"
SIZE = 150
PAD = 8

FONTS = {
    "sf": "/System/Library/Fonts/SFCompactRounded.ttf",
    "arial": "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf",
}


def glyph_svg_path(font_path: str, char: str, box: int = SIZE, pad: int = PAD) -> tuple[str, tuple[float, float, float, float]]:
    font = TTFont(font_path)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    name = cmap[ord(char)]
    glyph = glyph_set[name]
    upem = font["head"].unitsPerEm
    xmin = glyph._glyph.xMin if hasattr(glyph, "_glyph") and hasattr(glyph._glyph, "xMin") else 0
    # Use fontTools bounds via recording
    from fontTools.pens.boundsPen import BoundsPen

    bp = BoundsPen(glyph_set)
    glyph.draw(bp)
    x0, y0, x1, y1 = bp.bounds
    gw, gh = x1 - x0, y1 - y0
    inner = box - pad * 2
    scale = inner / max(gw, gh)
    # Center in box; flip Y
    tx = (box - gw * scale) / 2 - x0 * scale
    ty = (box + gh * scale) / 2 + y0 * scale  # after flip
    pen = SVGPathPen(glyph_set)
    tp = TransformPen(pen, Transform(scale, 0, 0, -scale, tx, ty))
    glyph.draw(tp)
    # Bounds after transform
    bx0 = x0 * scale + tx
    bx1 = x1 * scale + tx
    by0 = ty - y1 * scale
    by1 = ty - y0 * scale
    return pen.getCommands(), (bx0, by0, bx1, by1)


def eye_ellipses(bounds: tuple[float, float, float, float], kind: str) -> str:
    x0, y0, x1, y1 = bounds
    w, h = x1 - x0, y1 - y0
    # Vertical capsules, Reicon-like. Sit in the two upper masses.
    rx = w * 0.072
    ry = h * 0.132
    cy = y0 + h * 0.30
    if kind == "m_lower":
        # lowercase m: eyes sit in the two arches
        cx_l = x0 + w * 0.34
        cx_r = x0 + w * 0.72
        cy = y0 + h * 0.28
        rx = w * 0.070
        ry = h * 0.145
    else:
        cx_l = x0 + w * 0.28
        cx_r = x0 + w * 0.72
    def e(cx, cy):
        return (
            f"M {cx - rx:.2f} {cy:.2f} "
            f"C {cx - rx:.2f} {cy - ry * 0.55:.2f} {cx - rx * 0.55:.2f} {cy - ry:.2f} {cx:.2f} {cy - ry:.2f} "
            f"C {cx + rx * 0.55:.2f} {cy - ry:.2f} {cx + rx:.2f} {cy - ry * 0.55:.2f} {cx + rx:.2f} {cy:.2f} "
            f"C {cx + rx:.2f} {cy + ry * 0.55:.2f} {cx + rx * 0.55:.2f} {cy + ry:.2f} {cx:.2f} {cy + ry:.2f} "
            f"C {cx - rx * 0.55:.2f} {cy + ry:.2f} {cx - rx:.2f} {cy + ry * 0.55:.2f} {cx - rx:.2f} {cy:.2f} Z"
        )
    return e(cx_l, cy) + " " + e(cx_r, cy), (cx_l, cx_r, cy, rx, ry)


def svg_mascot(body_d: str, eyes_d: str, inflate: float = 0) -> str:
    # inflate via a matching stroke on the body (Reicon is chubbier than a regular bold)
    stroke = f'stroke="{FILL}" stroke-width="{inflate}" stroke-linejoin="round" stroke-linecap="round"' if inflate else ""
    return f'''<svg width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="{body_d}" fill="{FILL}" {stroke}/>
  <path d="{eyes_d}" fill="#FFFFFF"/>
</svg>
'''


def svg_evenodd(body_d: str, eyes_d: str) -> str:
    return f'''<svg width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" d="{body_d} {eyes_d}" fill="{FILL}"/>
</svg>
'''


def write_pair(stem: str, svg: str) -> None:
    svg_path = OUT / f"{stem}.svg"
    png_path = OUT / f"{stem}.png"
    small_path = OUT / f"{stem}-36.png"
    svg_path.write_text(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(png_path), output_width=300, output_height=300)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(small_path), output_width=72, output_height=72)
    print("wrote", stem)


def stroked_m(stroke: float, valley: float, kind: str = "M") -> tuple[str, tuple[float, float, float, float]]:
    """Chubby M from a round-capped skeleton. kind M or m."""
    if kind == "M":
        # skeleton in 150 box
        d = f"M 30 128 L 30 22 L 75 {valley} L 120 22 L 120 128"
        # approximate bounds of the stroke
        half = stroke / 2
        bounds = (30 - half, 22 - half, 120 + half, 128 + half)
        svg = f'''<svg width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}" xmlns="http://www.w3.org/2000/svg">
  <path d="{d}" fill="none" stroke="{FILL}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>'''
        return svg, bounds
    # lowercase m: left stem + two arches
    d = (
        "M 28 128 L 28 58 "
        "C 28 28 52 22 62 48 "
        "L 62 128 "
        "M 62 58 "
        "C 62 28 90 22 100 48 "
        "L 100 128"
    )
    half = stroke / 2
    bounds = (28 - half, 22 - half, 100 + half, 128 + half)
    svg = f'''<svg width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}" xmlns="http://www.w3.org/2000/svg">
  <path d="{d}" fill="none" stroke="{FILL}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>'''
    return svg, bounds


def overlay_eyes_on_svg(base_svg: str, bounds, kind: str) -> str:
    eyes_d, _ = eye_ellipses(bounds, kind)
    # Insert white eyes before closing svg
    return base_svg.replace("</svg>", f'  <path d="{eyes_d}" fill="#FFFFFF"/>\n</svg>')


def main() -> None:
    # A: SF Compact Rounded capital M + punched eyes (evenodd)
    d, b = glyph_svg_path(FONTS["sf"], "M")
    eyes, meta = eye_ellipses(b, "M")
    write_pair("a-sf-M", svg_evenodd(d, eyes))
    print("A bounds", [round(x, 1) for x in b], "eyes", [round(x, 1) for x in meta])

    # A2: same with inflate stroke so it matches Reicon chubbiness
    write_pair("a2-sf-M-fat", svg_mascot(d, eyes, inflate=7))

    # B: Arial Rounded Bold capital M
    d, b = glyph_svg_path(FONTS["arial"], "M")
    eyes, meta = eye_ellipses(b, "M")
    write_pair("b-arial-M", svg_evenodd(d, eyes))
    write_pair("b2-arial-M-fat", svg_mascot(d, eyes, inflate=8))
    print("B bounds", [round(x, 1) for x in b], "eyes", [round(x, 1) for x in meta])

    # C: SF lowercase m
    d, b = glyph_svg_path(FONTS["sf"], "m")
    eyes, meta = eye_ellipses(b, "m_lower")
    write_pair("c-sf-m", svg_evenodd(d, eyes))
    write_pair("c2-sf-m-fat", svg_mascot(d, eyes, inflate=8))
    print("C bounds", [round(x, 1) for x in b], "eyes", [round(x, 1) for x in meta])

    # D: skeleton-stroked capital M (the most Reicon-like construction)
    for stroke, valley, name in [
        (36, 78, "d-stroke-36"),
        (40, 82, "d2-stroke-40"),
        (44, 86, "d3-stroke-44"),
    ]:
        svg, bounds = stroked_m(stroke, valley, "M")
        write_pair(name, overlay_eyes_on_svg(svg, bounds, "M"))

    # E: skeleton-stroked lowercase m
    svg, bounds = stroked_m(34, 0, "m")
    write_pair("e-stroke-m", overlay_eyes_on_svg(svg, bounds, "m_lower"))

    # Reference: original Reicon R at same size
    r = (ROOT / "reicon_logo.svg").read_text()
    cairosvg.svg2png(url=str(ROOT / "reicon_logo.svg"), write_to=str(OUT / "ref-R.png"), output_width=300, output_height=300)
    cairosvg.svg2png(url=str(ROOT / "reicon_logo.svg"), write_to=str(OUT / "ref-R-36.png"), output_width=72, output_height=72)
    print("ref R written")


if __name__ == "__main__":
    main()
