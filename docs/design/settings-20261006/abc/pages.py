"""交付页：每页 3 张横排 + 一行标签；现状对照每版一张。"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
S = Path("/workspace/bys-settings-proto/shots"); P = S / "pages"; P.mkdir(exist_ok=True)
F = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 34)
CUR = Path("/home/box/agent-data/agents/b8a72d82-5172-42c1-9a24-768bd7279a2b/attachments/275c0a63f1fce4b8208067ec719c7e51a43ea1349b16f70833f7e1bd3fbe2b4c.png")
BG = "#e6e3dc"

def strip(items, out, H=1500, same_scale=False):
    ims = [Image.open(f).convert("RGB") for f, _ in items]
    ims = [im.resize((round(im.width * 1.1), round(im.height * 1.1)), Image.LANCZOS) if f == CUR else im for im, (f, _) in zip(ims, items)]  # 用户截图约 1.83x（560px 内容宽 ≈ 1038px），放到 2x 再比
    if same_scale:
        k = min(1, H / max(im.height for im in ims)); ims = [im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS) for im in ims]
    else:
        ims = [im.resize((round(im.width * H / im.height), H), Image.LANCZOS) if im.height > H else im for im in ims]
    pad, top = 40, 90
    W = sum(im.width for im in ims) + pad * (len(ims) + 1)
    Hh = max(im.height for im in ims) + top + pad
    o = Image.new("RGB", (W, Hh), BG); d = ImageDraw.Draw(o); x = pad
    for im, (_, label) in zip(ims, items):
        d.text((x, 26), label, fill="#3d3a33", font=F); o.paste(im, (x, top)); x += im.width + pad
    o.save(out); print(out.name, o.size)

strip([(S / "A-default.png", "A 安静列表"), (S / "B-default.png", "B 左右两栏"), (S / "C-default.png", "C 命令面板")], P / "page1-default.png")
strip([(S / "A-search-open.png", "A 搜 glm → 就地展开智谱"), (S / "B-search-detail.png", "B 搜 kimi → 右栏 Moonshot"), (S / "C-palette.png", "C ⌘K 搜 kimi")], P / "page2-interaction.png")
for v, name in (("A", "安静列表"), ("B", "左右两栏"), ("C", "命令面板")):
    strip([(CUR, "现在（main）"), (S / f"{v}-default.png", f"{v} {name}")], S / f"compare-current-vs-{v}.png", H=1600, same_scale=True)
