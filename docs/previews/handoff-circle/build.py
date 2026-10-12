"""把真实侧栏（10-11 抓下的 DOM + 产品样式表）和产品的手绘圈代码拼进预览页：python3 build.py"""
import json, re, pathlib

here = pathlib.Path(__file__).parent
repo = here.parents[2]
dom = (here / "panel-capture.html").read_text()
css = (repo / "extension/src/sidepanel/styles.css").read_text()

dom = re.sub(r"<script.*?</script>", "", dom, flags=re.S)
dom = re.sub(r'<link rel="stylesheet" href="[^"]*">', f"<style>{css}</style>", dom)
dom = re.sub(r'<img alt="" src="chrome-extension://[^"]*">', "", dom)
rough = (here.parent / "circle-and-memory/rough.js").read_text().replace("</", "<\\/")
page = (here / "template.html").read_text().replace('<script src="../circle-and-memory/rough.js"></script>', f"<script>{rough}</script>")
(here / "index.html").write_text(page.replace("__PANEL__", json.dumps(dom, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")))
print("index.html", len(dom))
