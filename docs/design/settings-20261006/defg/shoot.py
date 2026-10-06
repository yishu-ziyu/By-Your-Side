"""每个变体：默认 + 交互截图。640 宽 = 设置页 560 + 两侧 40，dsf 2。"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright
R = Path(__file__).parent; S = R / "shots"
URL = (R / "bys-settings-refs.html").as_uri()
only = sys.argv[1:] or list("DEFG")

async def page(ctx, v, h=1000):
    p = await ctx.new_page(); errs = []
    p.on("pageerror", lambda e: errs.append(str(e))); p.on("console", lambda m: m.type == "error" and errs.append(m.text))
    await p.set_viewport_size({"width": 640, "height": h})
    await p.goto(f"{URL}?nopicker&v={v}"); await p.wait_for_timeout(300); p._errs = errs; return p

async def shot(p, name):
    await p.wait_for_timeout(350)
    await p.screenshot(path=str(S / name)); print("wrote", name, p._errs or "")

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True)
        ctx = await b.new_context(device_scale_factor=2, reduced_motion="no-preference")
        if "D" in only:
            p = await page(ctx, "D"); await shot(p, "D-1-default.png")
            await p.click(".rc-plus"); await p.fill(".rc-menu-search input", "deep"); await p.wait_for_timeout(200)
            await shot(p, "D-2-addmenu.png")
            await p.click(".rc-menu .rc-mi"); await p.fill(".rc-add-row input", "sk-deepseek-4f2a"); await p.click(".rc-add-row .rc-btn:not(.is-primary)")
            await p.wait_for_timeout(1300); await shot(p, "D-3-verified.png")
            await p.click(".rc-row .rc-pop"); await p.wait_for_timeout(200); await shot(p, "D-4-modelmenu.png")
        if "E" in only:
            p = await page(ctx, "E"); await shot(p, "E-1-default.png")
            await p.evaluate("document.querySelector('[data-sec=deepseek]').scrollIntoView({block:'start'}); scrollBy(0,-60)")
            await p.fill("[data-sec=deepseek] .zd-input", "sk-deepseek-4f2a"); await p.wait_for_timeout(150)
            await shot(p, "E-2-typing.png")
            await p.press("[data-sec=deepseek] .zd-input", "Enter"); await p.wait_for_timeout(300)
            await p.evaluate("document.querySelector('[data-sec=deepseek]').scrollIntoView({block:'start'}); scrollBy(0,-60)")
            await shot(p, "E-3-saved.png")
        if "F" in only:
            p = await page(ctx, "F", 900); await shot(p, "F-1-default.png")
            await p.click(".cb-add"); await p.wait_for_timeout(250); await shot(p, "F-2-spotlight.png")
            await p.fill(".sp-input", "deep"); await p.wait_for_timeout(150); await shot(p, "F-2b-search.png")
            await p.press(".sp-input", "Enter"); await p.wait_for_timeout(400); await shot(p, "F-3-detail.png")
        if "G" in only:
            p = await page(ctx, "G"); await shot(p, "G-1-default.png")
            await p.click(".cl-iconbtn"); await p.keyboard.type("xiao"); await p.wait_for_timeout(200); await shot(p, "G-2-search.png")
            await p.click(".cl-row:nth-child(2) .cl-main"); await p.wait_for_timeout(400); await shot(p, "G-3-detail.png")
        await b.close()
asyncio.run(main())
