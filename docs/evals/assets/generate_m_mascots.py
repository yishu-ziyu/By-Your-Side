import cairosvg

# Variation 1: Chubby "M" Creature with Arched Belly & Ears (Ghost/Slime M)
# Two rounded top ears (x=38, x=112), valley dip at x=75, y=55.
# Left foot (x=16..52, y=136), Right foot (x=98..134, y=136).
# Bottom arch between feet: curves up to y=88 at x=75.
# Eyes: (x=50, y=66) and (x=100, y=66), or closer in center (x=60, x=90).

svg_v1 = '''<svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Body of M -->
  <path d="
    M 28 170
    C 18 170 14 162 14 150
    L 14 62
    C 14 36 34 16 60 16
    C 76 16 90 26 100 40
    C 110 26 124 16 140 16
    C 166 16 186 36 186 62
    L 186 150
    C 186 162 182 170 172 170
    C 162 170 156 162 156 150
    L 156 74
    C 156 56 148 44 136 44
    C 124 44 114 56 114 74
    L 114 140
    C 114 152 108 160 100 160
    C 92 160 86 152 86 140
    L 86 74
    C 86 56 76 44 64 44
    C 52 44 44 56 44 74
    L 44 150
    C 44 162 38 170 28 170
    Z
  " fill="#9B8AFB"/>
  <!-- Eyes -->
  <ellipse cx="64" cy="80" rx="9" ry="16" fill="white"/>
  <ellipse cx="136" cy="80" rx="9" ry="16" fill="white"/>
</svg>'''

# Variation 2: Super-chubby Reicon Slime "M" with cute arched bottom and two big expressive eyes
# Like a Totoro / Reicon squishy monster with two stubby rounded top ears!
svg_v2 = '''<svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Organic blobby M -->
  <path d="
    M 34 172
    C 18 172 12 158 12 138
    L 12 68
    C 12 36 36 16 64 16
    C 78 16 92 25 100 38
    C 108 25 122 16 136 16
    C 164 16 188 36 188 68
    L 188 138
    C 188 158 182 172 166 172
    C 152 172 144 160 144 142
    L 144 82
    C 144 64 135 52 122 52
    C 109 52 100 66 100 86
    L 100 115
    C 100 135 92 145 80 145
    C 70 145 64 136 64 120
    L 64 82
    C 64 64 55 52 44 52
    C 31 52 24 65 24 84
    L 24 142
    C 24 160 20 172 34 172
    Z
  " fill="#9B8AFB"/>
</svg>'''

# Variation 3: Perfect Reicon-Style Squishy "M" Mascot
# Notice Reicon's "R":
# Ultra smooth continuous Bezier curves with bulging roundness, heavy drop-bottom weight!
svg_v3 = '''<svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#9B8AFB" flood-opacity="0.3"/>
    </filter>
  </defs>
  <!-- Blobby M with high-precision organic Bezier curves -->
  <path d="
    M 28 168
    C 14 168 10 156 10 140
    C 10 120 12 80 12 60
    C 12 30 36 12 66 12
    C 82 12 94 22 100 34
    C 106 22 118 12 134 12
    C 164 12 188 30 188 60
    C 188 80 190 120 190 140
    C 190 156 186 168 172 168
    C 156 168 148 152 148 132
    L 148 76
    C 148 54 138 42 124 42
    C 112 42 104 54 104 72
    L 104 116
    C 104 136 96 148 84 148
    C 72 148 64 136 64 116
    L 64 72
    C 64 54 56 42 44 42
    C 30 42 22 54 22 76
    L 22 132
    C 22 152 18 168 28 168
    Z
  " fill="#9B8AFB" filter="url(#soft-shadow)"/>
  
  <!-- Eyes with blinking/glowing life -->
  <!-- Left Eye -->
  <ellipse cx="64" cy="78" rx="10" ry="18" fill="white"/>
  <ellipse cx="66" cy="78" rx="5" ry="9" fill="#2E1065"/>
  <circle cx="68" cy="74" r="2.5" fill="white"/>

  <!-- Right Eye -->
  <ellipse cx="136" cy="78" rx="10" ry="18" fill="white"/>
  <ellipse cx="138" cy="78" rx="5" ry="9" fill="#2E1065"/>
  <circle cx="140" cy="74" r="2.5" fill="white"/>
</svg>'''

with open('docs/evals/assets/m_v1.svg', 'w') as f: f.write(svg_v1)
with open('docs/evals/assets/m_v3.svg', 'w') as f: f.write(svg_v3)

cairosvg.svg2png(bytestring=svg_v1.encode('utf-8'), write_to='docs/evals/assets/m_v1.png')
cairosvg.svg2png(bytestring=svg_v3.encode('utf-8'), write_to='docs/evals/assets/m_v3.png')
print('Generated m_v1 and m_v3')
