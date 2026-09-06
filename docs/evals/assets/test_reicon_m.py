import cairosvg

# Reicon DNA:
# Dimensions: 150x150 viewBox
# Fill: #9B8AFB (soft periwinkle)
# Body: Ultra-chubby, squishy silhouette
# The letter M:
# Top has two rounded lobes (ears) at left (x=38, y=22) and right (x=112, y=22)
# Center dip between ears drops down to y=52
# Outer left curves down from x=16, y=50 to left foot at (16..54, 142)
# Outer right curves down from x=134, y=50 to right foot at (96..134, 142)
# Underneath between the feet:
# Can have a center notch / foot, OR an arched tummy!
# Let's test both!

# Design A: Plump "M" with center arch (looks like a squishy monster with two ears and two feet, and an M silhouette)
svg_a = '''<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="
    M 42 144
    C 28 144 14 136 12 118
    C 10 98 12 66 16 46
    C 20 26 34 10 52 10
    C 66 10 73 20 75 28
    C 77 20 84 10 98 10
    C 116 10 130 26 134 46
    C 138 66 140 98 138 118
    C 136 136 122 144 108 144
    C 96 144 88 134 88 122
    C 88 110 82 98 75 98
    C 68 98 62 110 62 122
    C 62 134 54 144 42 144
    Z
    M 55 46
    C 48 46 44 54 44 68
    C 44 82 48 90 55 90
    C 62 90 66 82 66 68
    C 66 54 62 46 55 46
    Z
    M 95 46
    C 88 46 84 54 84 68
    C 84 82 88 90 95 90
    C 102 90 106 82 106 68
    C 106 54 102 46 95 46
    Z
  " fill="#9B8AFB" fill-rule="evenodd"/>
</svg>'''

# Design B: True 3-legged "M" Creature (Left leg, Center leg/tongue, Right leg)
# In Reicon style, solid chubby body with 3 rounded base pods and 2 top ear bumps
svg_b = '''<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="
    M 34 144
    C 20 144 12 134 12 116
    C 12 70 14 44 26 24
    C 36 8 54 8 66 22
    L 75 34
    L 84 22
    C 96 8 114 8 124 24
    C 136 44 138 70 138 116
    C 138 134 130 144 116 144
    C 104 144 96 134 96 118
    L 96 82
    C 96 68 88 60 75 60
    C 62 60 54 68 54 82
    L 54 118
    C 54 134 46 144 34 144
    Z
    M 44 48
    C 38 48 35 55 35 66
    C 35 77 38 84 44 84
    C 50 84 53 77 53 66
    C 53 55 50 48 44 48
    Z
    M 106 48
    C 100 48 97 55 97 66
    C 97 77 100 84 106 84
    C 112 84 115 77 115 66
    C 115 55 112 48 106 48
    Z
  " fill="#9B8AFB" fill-rule="evenodd"/>
</svg>'''

# Design C: The "Super Reicon" Chubby M (Soft marshmallow form, organic blob with eyes)
# The dip at the top is soft like an apple/heart, bottom has two cute chubby paws,
# and in the center between the ears sit the two classic Reicon oval eyes!
svg_c = '''<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="
    M 38 144
    C 20 144 12 132 12 110
    C 12 72 16 42 28 22
    C 38 6 58 6 70 18
    C 73 21 75 24 75 26
    C 75 24 77 21 80 18
    C 92 6 112 6 122 22
    C 134 42 138 72 138 110
    C 138 132 130 144 112 144
    C 98 144 90 132 90 114
    C 90 98 84 86 75 86
    C 66 86 60 98 60 114
    C 60 132 52 144 38 144
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

with open('docs/evals/assets/m_a.svg', 'w') as f: f.write(svg_a)
with open('docs/evals/assets/m_b.svg', 'w') as f: f.write(svg_b)
with open('docs/evals/assets/m_c.svg', 'w') as f: f.write(svg_c)

cairosvg.svg2png(bytestring=svg_a.encode('utf-8'), write_to='docs/evals/assets/m_a.png')
cairosvg.svg2png(bytestring=svg_b.encode('utf-8'), write_to='docs/evals/assets/m_b.png')
cairosvg.svg2png(bytestring=svg_c.encode('utf-8'), write_to='docs/evals/assets/m_c.png')

print("All 3 SVGs rendered to PNG!")
