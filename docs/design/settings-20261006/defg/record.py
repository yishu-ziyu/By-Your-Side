"""每个变体录一段 ≤15s 操作视频（webm → mp4）。"""
import asyncio, sys, subprocess, shutil
from pathlib import Path
from playwright.async_api import async_playwright
R = Path(__file__).parent; V = R / "videos"; URL = (R / "bys-settings-refs.html").as_uri()
only = sys.argv[1:] or list("DEFG")
W, H = 640, 900

async def D(p):
    await p.wait_for_timeout(900); await p.hover(".rc-plus"); await p.wait_for_timeout(300); await p.click(".rc-plus"); await p.wait_for_timeout(500)
    await p.type(".rc-menu-search input", "deep", delay=120); await p.wait_for_timeout(500)
    await p.click(".rc-menu .rc-mi"); await p.wait_for_timeout(400)
    await p.type(".rc-add-row input", "sk-deepseek-4f2a", delay=45); await p.wait_for_timeout(300)
    await p.click(".rc-add-row .rc-btn:not(.is-primary)"); await p.wait_for_timeout(1500)
    await p.click(".rc-add-row .rc-btn.is-primary"); await p.wait_for_timeout(900)
    await p.click(".rc-row .rc-pop"); await p.wait_for_timeout(1300)
    await p.keyboard.press("Escape"); await p.wait_for_timeout(600)

async def E(p):
    await p.wait_for_timeout(900)
    for _ in range(8): await p.mouse.wheel(0, 180); await p.wait_for_timeout(120)
    await p.evaluate("document.querySelector('[data-sec=deepseek]').scrollIntoView({block:'center',behavior:'smooth'})"); await p.wait_for_timeout(900)
    await p.click("[data-sec=deepseek] .zd-input"); await p.type("[data-sec=deepseek] .zd-input", "sk-deepseek-4f2a", delay=55); await p.wait_for_timeout(400)
    await p.press("[data-sec=deepseek] .zd-input", "Enter"); await p.wait_for_timeout(1500)
    await p.evaluate("scrollTo({top:0,behavior:'smooth'})"); await p.wait_for_timeout(900)
    await p.type(".zd-searchwrap input", "kimi", delay=120); await p.wait_for_timeout(1300)

async def F(p):
    await p.wait_for_timeout(1000); await p.hover(".cb-add"); await p.wait_for_timeout(300); await p.click(".cb-add"); await p.wait_for_timeout(800)
    await p.keyboard.press("ArrowDown"); await p.wait_for_timeout(250); await p.keyboard.press("ArrowDown"); await p.wait_for_timeout(400)
    await p.type(".sp-input", "deep", delay=130); await p.wait_for_timeout(600)
    await p.press(".sp-input", "Enter"); await p.wait_for_timeout(900)
    await p.type(".pv-form input[type=password], .pv-form input", "sk-deepseek-4f2a", delay=50); await p.wait_for_timeout(400)
    await p.get_by_role("button", name="保存并使用").click(); await p.wait_for_timeout(1500)

async def G(p):
    await p.wait_for_timeout(1000); await p.click(".cl-iconbtn"); await p.wait_for_timeout(300)
    await p.keyboard.type("xiao", delay=140); await p.wait_for_timeout(700)
    await p.hover(".cl-row:nth-child(2) .cl-main"); await p.wait_for_timeout(300); await p.click(".cl-row:nth-child(2) .cl-main"); await p.wait_for_timeout(1400)
    await p.get_by_text("服务商", exact=True).first.click(); await p.wait_for_timeout(800)
    await p.keyboard.press("Escape"); await p.fill(".cl-search input", ""); await p.wait_for_timeout(300)
    await p.mouse.move(320, 500)
    for _ in range(6): await p.mouse.wheel(0, 160); await p.wait_for_timeout(150)
    await p.wait_for_timeout(500)

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True)
        for v in only:
            tmp = V / f"_{v}"; shutil.rmtree(tmp, ignore_errors=True)
            ctx = await b.new_context(viewport={"width": W, "height": H}, record_video_dir=str(tmp), record_video_size={"width": W, "height": H}, reduced_motion="no-preference")
            p = await ctx.new_page(); errs = []; p.on("pageerror", lambda e: errs.append(str(e)))
            await p.goto(f"{URL}?nopicker&v={v}")
            try: await globals()[v](p)
            except Exception as e: errs.append(repr(e))
            await ctx.close(); webm = next(tmp.glob("*.webm"))
            out = V / f"{v}.mp4"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(webm), "-t", "15", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", str(out)], check=True)
            shutil.rmtree(tmp); print("wrote", out.name, errs or "")
        await b.close()
asyncio.run(main())
