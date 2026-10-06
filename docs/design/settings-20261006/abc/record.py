"""录屏：2560×1800 视口 + 页面 zoom 2（= 1280×900 @2x），ffmpeg 裁到内容列转 mp4。每段 ≤15 秒。"""
import asyncio, subprocess, shutil, sys
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path("/workspace/bys-settings-proto"); VID = ROOT / "videos"; RAW = VID / "_raw"; RAW.mkdir(parents=True, exist_ok=True)
URL = f"file://{ROOT}/bys-settings-proto.html?nopicker"
CURSOR = """
addEventListener('DOMContentLoaded', () => {
  document.documentElement.style.zoom = '2';
    const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(20,20,19,.28);border:1.5px solid rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none;z-index:99999;transform:translate(-50px,-50px)';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX/2}px,${e.clientY/2}px)`; }, true);
  addEventListener('mousedown', () => { c.style.background = 'rgba(45,74,134,.5)'; }, true);
  addEventListener('mouseup', () => { c.style.background = 'rgba(20,20,19,.28)'; }, true);
});"""

async def center(p, sel):
    bb = await p.locator(sel).first.bounding_box(); return bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
async def glide(p, sel, steps=16):
    x, y = await center(p, sel); await p.mouse.move(x, y, steps=steps)
async def click(p, sel, steps=16, pause=200):
    await glide(p, sel, steps); await p.wait_for_timeout(pause); await p.mouse.down(); await p.wait_for_timeout(70); await p.mouse.up()

async def flow_a(p):
    await p.wait_for_timeout(700)
    await click(p, ".search-input"); await p.wait_for_timeout(200)
    await p.keyboard.type("glm", delay=140); await p.wait_for_timeout(900)
    await click(p, ".a-row[data-key='zai-coding-cn']"); await p.wait_for_timeout(900)
    await click(p, ".a-detail .combo-btn"); await p.wait_for_timeout(700)
    await click(p, ".combo-list:not([hidden]) .combo-opt[data-id='glm-5.3']", steps=10); await p.wait_for_timeout(600)
    await click(p, ".a-detail .btn-primary"); await p.wait_for_timeout(1200)
    await p.evaluate("window.scrollTo({top:0,behavior:'smooth'})"); await glide(p, ".a-current"); await p.wait_for_timeout(1500)

async def flow_b(p):
    await p.wait_for_timeout(700)
    await click(p, ".search-input"); await p.keyboard.type("kimi", delay=140); await p.wait_for_timeout(900)
    await click(p, ".b-row[data-key='kimi-coding']"); await p.wait_for_timeout(900)
    await click(p, ".ml-row:has-text('kimi-for-coding-highspeed')"); await p.wait_for_timeout(600)
    await click(p, ".b-pane .btn-primary"); await p.wait_for_timeout(1000)
    await glide(p, ".b-cur"); await p.wait_for_timeout(1600)

async def flow_c(p):
    await p.wait_for_timeout(700)
    await click(p, ".c-change"); await p.wait_for_timeout(700)
    await p.keyboard.type("kimi", delay=140); await p.wait_for_timeout(800)
    for _ in range(4): await p.keyboard.press("ArrowDown"); await p.wait_for_timeout(260)
    await p.wait_for_timeout(300); await p.keyboard.press("Enter"); await p.wait_for_timeout(1300)
    await click(p, ".c-change"); await p.wait_for_timeout(600)
    await p.keyboard.type("deepseek", delay=110); await p.wait_for_timeout(700)
    await click(p, ".c-opt[data-k='deepseek']"); await p.wait_for_timeout(1700)

async def rec(pw, v, flow, width):
    b = await pw.chromium.launch(channel="chrome", headless=True)
    ctx = await b.new_context(viewport={"width": 2560, "height": 1800}, device_scale_factor=1, record_video_dir=str(RAW), record_video_size={"width": 2560, "height": 1800})
    await ctx.add_init_script(CURSOR)
    p = await ctx.new_page(); await p.goto(f"{URL}&v={v}"); await p.mouse.move(1280, 1700)
    await flow(p)
    path = await p.video.path(); await ctx.close(); await b.close()
    w = width * 2; x = (2560 - w) // 2
    out = VID / f"{v}-flow.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.4", "-i", path, "-t", "15", "-vf", f"crop={w}:1800:{x}:0,scale={w//2*2}:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "medium", "-movflags", "+faststart", str(out)], check=True)
    print("wrote", out)

async def main():
    which = sys.argv[1:] or ["A", "B", "C"]
    async with async_playwright() as pw:
        for v in which:
            await rec(pw, v, {"A": flow_a, "B": flow_b, "C": flow_c}[v], {"A": 620, "B": 860, "C": 620}[v])
    shutil.rmtree(RAW, ignore_errors=True)

asyncio.run(main())
