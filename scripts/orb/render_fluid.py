"""离线渲染语音光球的循环视频（#124，docs/evals/20261007-voice-orb-styles.md）。

二维不可压缩流体（半拉格朗日平流 + FFT 投影）推动云的浓度场，再上色、加磨砂错位与颗粒，
首尾交叉淡化成无缝循环，用 ffmpeg 编成 mp4。产物放 extension/assets/orbs/<配色>.mp4。

用法：python3 scripts/orb/render_fluid.py extension/assets/orbs [边长，默认 320]
依赖：numpy、scipy、Pillow、ffmpeg。
"""
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

OUT = sys.argv[1]
N = 160              # 模拟网格
SIZE = int(sys.argv[2]) if len(sys.argv) > 2 else 320  # 输出边长；侧栏最大 160px，2 倍屏够用
FPS = 60
LOOP = 12 * FPS      # 循环长度
FADE = 3 * FPS       # 首尾交叉淡化
WARM = 240           # 预热步数，让流场先成形
DT = 0.5             # 每帧的模拟步长：60 帧下流动整体放慢一半，逐帧位移更小更顺
rng = np.random.default_rng(7)

yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
kx = np.fft.fftfreq(N)[None, :] * 2 * np.pi
ky = np.fft.fftfreq(N)[:, None] * 2 * np.pi
k2 = kx ** 2 + ky ** 2
k2[0, 0] = 1.0


def fbm(seed, octaves=5, scale=4):
    g = np.random.default_rng(seed)
    out = np.zeros((N, N))
    amp = 1.0
    for o in range(octaves):
        n = g.standard_normal((N, N))
        out += amp * gaussian_filter(n, sigma=N / (scale * 2 ** o), mode="wrap")
        amp *= 0.55
    out -= out.min()
    return out / out.max()


def advect(field, u, v, dt):
    return map_coordinates(field, [yy - v * dt, xx - u * dt], order=1, mode="grid-wrap")


def project(u, v):
    uh, vh = np.fft.fft2(u), np.fft.fft2(v)
    div = 1j * kx * uh + 1j * ky * vh
    p = div / -k2
    uh -= 1j * kx * p
    vh -= 1j * ky * p
    return np.real(np.fft.ifft2(uh)), np.real(np.fft.ifft2(vh))


# 几个缓慢绕行的涡源：大尺度、柔和，像风推着云。
VORTS = [(0.32, 0.38, 0.26, 1.0, 0.0), (0.70, 0.64, 0.28, -0.8, 1.7)]


def force(t):
    fu = np.zeros((N, N))
    fv = np.zeros((N, N))
    for cx, cy, r, s, ph in VORTS:
        x0 = (cx + 0.08 * np.cos(t * 0.3 + ph)) * N
        y0 = (cy + 0.08 * np.sin(t * 0.25 + ph)) * N
        dx, dy = xx - x0, yy - y0
        w = np.exp(-(dx ** 2 + dy ** 2) / (2 * (r * N) ** 2))
        fu += -dy * w * s * 0.0025
        fv += dx * w * s * 0.0025
    return fu, fv


u = np.zeros((N, N))
v = np.zeros((N, N))
dye = fbm(1)
base = fbm(2, octaves=3, scale=2)
frames = []
total = WARM + LOOP + FADE
for step in range(total):
    t = step / FPS
    fu, fv = force(t)
    u, v = u + fu * DT, v + fv * DT
    u, v = advect(u, u, v, DT), advect(v, u, v, DT)
    u, v = project(u * 0.995 ** DT, v * 0.995 ** DT)
    dye = advect(dye, u, v, DT)
    # 云不会耗尽：缓慢回到底层分布，同时保留被流场拉出的丝。
    dye = dye * (1 - 0.008 * DT) + base * 0.008 * DT
    if step >= WARM:
        frames.append(dye.copy())

# 首尾交叉淡化：输出第 i 帧 = 模拟第 LOOP+i 帧与第 i 帧按权重混合（i < FADE），保证最后一帧接回第一帧。
loop = []
for i in range(LOOP):
    if i < FADE:
        w = i / FADE
        loop.append(frames[LOOP + i] * (1 - w) + frames[i] * w)
    else:
        loop.append(frames[i])

PALETTES = {
    # 暖纸：墨灰褐 → 纸白，夹一点杏色
    # 暮色：产品蓝（#2d4a86）→ 雾紫 → 杏色云
    "dusk": [(0.15, 0.23, 0.45), (0.45, 0.45, 0.66), (0.91, 0.75, 0.66), (1.0, 0.96, 0.92)],
    # 晨光：淡杏 → 奶白
    "dawn": [(0.86, 0.55, 0.38), (0.95, 0.76, 0.60), (0.99, 0.90, 0.80), (1.0, 0.985, 0.96)],
}

Y, X = np.mgrid[0:SIZE, 0:SIZE] / SIZE
diag = np.clip((X + (1 - Y)) * 0.55 - 0.1, 0, 1)             # 左上深、右下亮
frost = np.stack([gaussian_filter(np.random.default_rng(3 + k).standard_normal((SIZE, SIZE)), 0.75 * SIZE / 512) for k in range(2)]) * 12 * SIZE / 512  # 磨砂：固定的细碎错位（像素），带一点结构像玻璃颗粒
grain = np.random.default_rng(4).standard_normal((24, SIZE, SIZE)).astype(np.float32)


def ramp(c, pal):
    stops = np.array(pal)
    pos = np.clip(c, 0, 1) * (len(stops) - 1)
    i = np.clip(pos.astype(int), 0, len(stops) - 2)
    f = (pos - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


for name, pal in PALETTES.items():
    d = tempfile.mkdtemp(prefix=f"orb-{name}-")
    for i, field in enumerate(loop):
        soft = gaussian_filter(field, 2.8, mode="wrap")              # 揉开细丝，云成团
        img = np.array(Image.fromarray((np.clip(soft, 0, 1) * 65535).astype(np.uint16)).resize((SIZE, SIZE), Image.BICUBIC), dtype=np.float64) / 65535
        img = map_coordinates(img, [Y * SIZE + frost[1], X * SIZE + frost[0]], order=1, mode="nearest")
        lo, hi = np.percentile(img, 35), np.percentile(img, 97)
        cloud = np.clip((img - lo) / (hi - lo), 0, 1)
        cloud = cloud * cloud * (3 - 2 * cloud)
        c = np.clip(diag * 0.85 + cloud * 0.55 - 0.05, 0, 1)
        rgb = ramp(c, pal) + grain[i % len(grain)][..., None] * 0.010
        Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(os.path.join(d, f"{i:04d}.png"))
    os.makedirs(OUT, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(d, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "26", "-preset", "slow", "-movflags", "+faststart", os.path.join(OUT, f"{name}.mp4")], check=True)
    shutil.rmtree(d)
    print(name, os.path.getsize(os.path.join(OUT, f"{name}.mp4")), "bytes")
