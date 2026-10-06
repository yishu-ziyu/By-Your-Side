"""截图：1280 宽 @2x，裁到内容列。用法：python3 shoot.py [wip]"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path("/workspace/bys-settings-proto"); SHOTS = ROOT / "shots"; SHOTS.mkdir(exist_ok=True)
URL = f"file://{ROOT}/bys-settings-proto.html"

async def page_at(b, q, h=1000):
    ctx = await b.new_context(viewport={"width": 1280, "height": h}, device_scale_factor=2)
    p = await ctx.new_page(); errs = []; reqs = []
    p.on("pageerror", lambda e: errs.append(str(e))); p.on("console", lambda m: m.type == "error" and errs.append(m.text))
    p.on("request", lambda r: not r.url.startswith(("file:", "data:")) and reqs.append(r.url))
    await p.goto(f"{URL}?nopicker&{q}"); await p.wait_for_timeout(400)
    p._errs, p._reqs = errs, reqs
    return p

async def clip(p, name, y=0, h=None, sel_bottom=None, pad=24):
    box = await p.evaluate("(()=>{const r=document.querySelector('#settings').getBoundingClientRect();return [r.left,r.width]})()")
    if sel_bottom:
        bottom = await p.evaluate(f"(()=>{{let m=0;for(const e of document.querySelectorAll({sel_bottom!r})){{if(e.hidden||!e.offsetParent&&getComputedStyle(e).position!=='fixed')continue;const r=e.getBoundingClientRect();m=Math.max(m,r.bottom+scrollY)}}return m}})()")
        h = bottom + pad - y
    await p.screenshot(path=str(SHOTS / name), clip={"x": box[0], "y": y, "width": box[1], "height": h}, full_page=True)
    print("wrote", name, int(h), "errors:", p._errs, "requests:", p._reqs)

MODEL = "#settings > section:first-of-type, .combo-list:not([hidden]), .c-pal:not([hidden])"

async def main():
    wip = "wip" in sys.argv
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True)
        for v in ("" if "inter" in sys.argv else "ABC"):
            p = await page_at(b, f"v={v}")
            if v == "C": await clip(p, f"{'wip-' if wip else ''}C-default.png", 0, h=678)
            else: await clip(p, f"{'wip-' if wip else ''}{v}-default.png", 0, sel_bottom=MODEL)
            if not wip:
                await clip(p, f"{v}-fullpage.png", 0, sel_bottom="#settings > section")
            await p.context.close()
        if wip: return
        # 交互态
        p = await page_at(b, "v=A")
        await p.click(".search-input"); await p.keyboard.type("glm", delay=40); await p.wait_for_timeout(300)
        await p.evaluate("__a.open('zai-coding-cn')"); await p.wait_for_timeout(400)
        await p.evaluate("document.querySelector('.a-search-dummy')")
        await clip(p, "A-search-open.png", 0, sel_bottom=MODEL); await p.context.close()
        p = await page_at(b, "v=B")
        await p.click(".search-input"); await p.keyboard.type("kimi", delay=40); await p.wait_for_timeout(250)
        await p.click(".b-row[data-key='moonshot*']"); await p.wait_for_timeout(300)
        await p.hover(".ml-row:nth-child(3)"); await p.wait_for_timeout(200)
        await clip(p, "B-search-detail.png", 0, sel_bottom=MODEL); await p.context.close()
        p = await page_at(b, "v=C", 1100)
        await p.click(".c-change"); await p.wait_for_timeout(250)
        await p.keyboard.type("kimi", delay=40); await p.wait_for_timeout(300)
        await clip(p, "C-palette.png", 0, sel_bottom=MODEL); await p.context.close()
        await b.close()

asyncio.run(main())
