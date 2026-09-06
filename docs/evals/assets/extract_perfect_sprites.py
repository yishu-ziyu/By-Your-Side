from PIL import Image
import numpy as np
from collections import deque
import json, base64

def clean_sprite(img_path, y_min, y_max, x_min, x_max, thresh=130, white_cutoff=140):
    img = Image.open(img_path).convert('RGBA')
    arr = np.array(img)
    crop = arr[y_min:y_max, x_min:x_max].copy()
    h, w, _ = crop.shape
    
    visited = np.zeros((h, w), dtype=bool)
    queue = deque()
    
    # Init border
    for y in range(h):
        for x in [0, w-1]:
            if not visited[y, x] and np.mean(crop[y, x, :3]) > thresh:
                visited[y, x] = True
                queue.append((y, x))
    for x in range(w):
        for y in [0, h-1]:
            if not visited[y, x] and np.mean(crop[y, x, :3]) > thresh:
                visited[y, x] = True
                queue.append((y, x))
                
    while queue:
        cy, cx = queue.popleft()
        for dy, dx in [(-1,0), (1,0), (0,-1), (0,1)]:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx]:
                if np.mean(crop[ny, nx, :3]) > white_cutoff:
                    visited[ny, nx] = True
                    queue.append((ny, nx))
                    
    crop[visited, 3] = 0
    return Image.fromarray(crop)

# 1. Point / Idle (standing pointing to input box)
point_img = clean_sprite('docs/evals/assets/lil_pix_frames/state_standing_point.png', 50, 88, 23, 68)
point_img.save('docs/evals/assets/lil_pix_authentic/pix_point_perfect.png')

# 2. Lean Left (curious peek leaning on rim while typing)
lean_img = clean_sprite('docs/evals/assets/lil_pix_frames/state_lean_left.png', 29, 66, 12, 50)
lean_img.save('docs/evals/assets/lil_pix_authentic/pix_lean_perfect.png')

# 3. Tap / Dance (happy feet / walk)
tap_img = clean_sprite('docs/evals/assets/lil_pix_frames/state_standing_tap.png', 10, 63, 22, 62)
tap_img.save('docs/evals/assets/lil_pix_authentic/pix_tap_perfect.png')

# 4. Pet Happy (crescent eyes ^^ under glove)
pet_img = clean_sprite('docs/evals/assets/lil_pix_frames/state_pet_rub_1.png', 34, 76, 22, 65)
pet_img.save('docs/evals/assets/lil_pix_authentic/pix_pet_happy_perfect.png')

# 5. Glove
def clean_glove(img_path, y_min, y_max, x_min, x_max):
    img = Image.open(img_path).convert('RGBA')
    arr = np.array(img)
    crop = arr[y_min:y_max, x_min:x_max].copy()
    h, w, _ = crop.shape
    
    visited = np.zeros((h, w), dtype=bool)
    queue = deque()
    for y in range(h):
        for x in [0, w-1]:
            if not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    for x in range(w):
        for y in [0, h-1]:
            if not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
                
    while queue:
        cy, cx = queue.popleft()
        for dy, dx in [(-1,0), (1,0), (0,-1), (0,1)]:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx]:
                if np.mean(crop[ny, nx, :3]) > 170:
                    visited[ny, nx] = True
                    queue.append((ny, nx))
    crop[visited, 3] = 0
    return Image.fromarray(crop)

glove_img = clean_glove('docs/evals/assets/lil_pix_frames/state_glove_hover.png', 0, 36, 23, 62)
glove_img.save('docs/evals/assets/lil_pix_authentic/pix_glove_perfect.png')

# Save Base64 json for html embed
sprites = {
    'pix_point': 'data:image/png;base64,' + base64.b64encode(open('docs/evals/assets/lil_pix_authentic/pix_point_perfect.png', 'rb').read()).decode('utf-8'),
    'pix_lean': 'data:image/png;base64,' + base64.b64encode(open('docs/evals/assets/lil_pix_authentic/pix_lean_perfect.png', 'rb').read()).decode('utf-8'),
    'pix_tap': 'data:image/png;base64,' + base64.b64encode(open('docs/evals/assets/lil_pix_authentic/pix_tap_perfect.png', 'rb').read()).decode('utf-8'),
    'pix_pet_happy': 'data:image/png;base64,' + base64.b64encode(open('docs/evals/assets/lil_pix_authentic/pix_pet_happy_perfect.png', 'rb').read()).decode('utf-8'),
    'pix_glove': 'data:image/png;base64,' + base64.b64encode(open('docs/evals/assets/lil_pix_authentic/pix_glove_perfect.png', 'rb').read()).decode('utf-8'),
}
with open('docs/evals/assets/lil_pix_authentic/sprites_perfect_b64.json', 'w') as f:
    json.dump(sprites, f, indent=2)

print("All perfect sprites extracted and saved!")
