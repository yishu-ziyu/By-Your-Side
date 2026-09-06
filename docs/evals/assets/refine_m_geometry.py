import cairosvg

# Let's craft the definitive Reicon "M" geometry.
# Reicon's R characteristics:
# - Height ~138, Width ~126 in 150x150
# - Soft bulging curves (continuous G2 curvature, no sharp kinks)
# - Eyes: rx=10..11, ry=19..22, vertical capsules
# For "M":
# - Width: 132, Height: 136 in 150x150
# - Two rounded lobes at top (x=42, y=20 and x=108, y=20)
# - Soft valley dip at x=75, y=34
# - Left outer flank curves from (12, 50) down to (12, 114) and bulbous left foot (12..52, 144)
# - Right outer flank curves from (138, 50) down to (138, 114) and bulbous right foot (98..138, 144)
# - Underbelly arch curves up from left foot (52, 144) -> (60, 118) -> (75, 96) -> (90, 118) -> (98, 144)
# - Eye cutouts:
#   Left eye: cx=54, cy=64, rx=10, ry=18
#   Right eye: cx=96, cy=64, rx=10, ry=18

svg_perfect_m = '''<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Outer Body + Eye Cutouts in EvenOdd rule -->
  <path d="
    M 38 144
    C 20 144 11 132 10 112
    C 9 86 11 54 20 34
    C 28 16 42 8 58 8
    C 67 8 72 14 75 20
    C 78 14 83 8 92 8
    C 108 8 122 16 130 34
    C 139 54 141 86 140 112
    C 139 132 130 144 112 144
    C 98 144 91 132 90 114
    C 89 98 84 86 75 86
    C 66 86 61 98 60 114
    C 59 132 52 144 38 144
    Z
    M 54 44
    C 46 44 42 53 42 66
    C 42 79 46 88 54 88
    C 62 88 66 79 66 66
    C 66 53 62 44 54 44
    Z
    M 96 44
    C 88 44 84 53 84 66
    C 84 79 88 88 96 88
    C 104 88 108 79 108 66
    C 108 53 104 44 96 44
    Z
  " fill="#9B8AFB" fill-rule="evenodd"/>
</svg>'''

with open('docs/evals/assets/reicon_m_perfect.svg', 'w') as f:
    f.write(svg_perfect_m)

cairosvg.svg2png(bytestring=svg_perfect_m.encode('utf-8'), write_to='docs/evals/assets/reicon_m_perfect.png')
print('Rendered reicon_m_perfect.png')
