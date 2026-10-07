"""把真实侧栏（验收时抓下的 DOM + 产品样式表）拼进预览页：python3 build.py"""
import json, re, pathlib

here = pathlib.Path(__file__).parent
repo = here.parents[2]
dom = (repo / "out/acceptance/memory-used-line/R1-collapsed.html").read_text()
css = (repo / "extension/src/sidepanel/styles.css").read_text()

dom = re.sub(r"<script.*?</script>", "", dom, flags=re.S)
dom = dom.replace('<link rel="stylesheet" href="styles.css">', f"<style>{css}</style>")
dom = re.sub(r'<img alt="" src="chrome-extension://[^"]*">', "", dom)
(here / "index.html").write_text((here / "template.html").read_text().replace("__PANEL__", json.dumps(dom, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")))
print("index.html", len(dom))
