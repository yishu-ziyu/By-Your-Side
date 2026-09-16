"""Render the approved paired-stroke mark as SVG and toolbar PNGs (no dependencies)."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[2] / 'extension' / 'icons'
STROKES = ((53, 22, 32, 79), (94, 41, 73, 98))
RADIUS = 13
INK = (41, 40, 33)
PAPER = (245, 242, 235)


def in_stroke(x, y, line):
    ax, ay, bx, by = line
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy) <= RADIUS


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def render(size):
    # Supersample the same capsule geometry as the SVG for crisp small toolbar sizes.
    samples = 4
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)  # PNG row filter: none
        for x in range(size):
            coverage = sum(
                any(in_stroke((x + (sx + .5) / samples) * 128 / size,
                              (y + (sy + .5) / samples) * 128 / size, line)
                    for line in STROKES)
                for sy in range(samples) for sx in range(samples)
            ) / samples ** 2
            pixels.extend(round(bg + (fg - bg) * coverage) for bg, fg in zip(PAPER, INK))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


paths = ''.join(f'<path d="M{ax} {ay}L{bx} {by}"/>' for ax, ay, bx, by in STROKES)
(ROOT / 'brand-mark.svg').write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    f'<g fill="none" stroke="#292821" stroke-width="26" stroke-linecap="round">{paths}</g></svg>\n'
)
for size in (16, 48, 128):
    (ROOT / f'icon-{size}.png').write_bytes(render(size))
