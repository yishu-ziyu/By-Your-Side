"""把真实侧栏（验收时抓下的 DOM + 产品样式表）拼进预览页：python3 build.py"""
import json, pathlib

here = pathlib.Path(__file__).parent
repo = here.parents[2]
dom = (here / "panel-source.html").read_text()
css = (repo / "extension/src/sidepanel/styles.css").read_text()

dom = dom.replace('<link rel="stylesheet" href="styles.css">', f"<style>{css}</style>")
panel = json.dumps(dom, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")
(here / "index.html").write_text((here / "template.html").read_text().replace("__PANEL__", panel))
print("index.html", len(dom))
