"""把真实侧栏（探针抓下的 DOM + 产品样式表）和真实阅读卡样式拼进预览页：python3 build.py"""
import json, pathlib, re

here = pathlib.Path(__file__).parent
repo = here.parents[2]
dom = (repo / "out/probes/reading-correction/2026-10-10T08-17-23-387Z/B3-panel-done.html").read_text()
css = (repo / "extension/src/sidepanel/styles.css").read_text()
ask = (repo / "extension/src/content/ask-styles.ts").read_text()
ask_css = re.search(r"ASK_STYLES = `(.*?)`;", ask, re.S).group(1)

dom = re.sub(r"<script.*?</script>", "", dom, flags=re.S)
dom = dom.replace('<link rel="stylesheet" href="styles.css">', f"<style>{css}</style>")
dom = re.sub(r'<img alt="" src="chrome-extension://[^"]*">', "", dom)
dom = re.sub(r'<div id="messages">.*?<div id="resume-entry-root"', '<div id="messages"><div id="resume-entry-root"', dom, flags=re.S)
dom = dom.replace('<section id="starter"', '<section id="starter" hidden')


def js(value: str) -> str:
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")


page = (here / "template.html").read_text().replace("__PANEL__", js(dom)).replace("__ASK_STYLES__", js(ask_css))
page = page.replace("__PREVIEW_JS__", (here / "preview.js").read_text())
(here / "index.html").write_text(page)
print("index.html", len(page))
