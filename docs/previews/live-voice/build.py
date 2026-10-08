"""把真实侧栏（验收时抓下的 DOM + 产品样式表）拼进预览页：python3 build.py"""
import json, re, pathlib

here = pathlib.Path(__file__).parent
repo = here.parents[2]
main = pathlib.Path("/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side")
rel = "out/acceptance/real-path/2026-10-07T09-54-16-139Z-everyday-baseline-sitegeist-inproc/research-panel-wait-8s.html"
dom = next((r / rel) for r in (repo, main) if (r / rel).exists()).read_text()
css = (repo / "extension/src/sidepanel/styles.css").read_text()

dom = re.sub(r"<script.*?</script>", "", dom, flags=re.S)
dom = dom.replace('<link rel="stylesheet" href="styles.css">', f"<style>{css}</style>")
dom = re.sub(r'<img alt="" src="chrome-extension://[^"]*">', "", dom)
# 对话区清空，由 preview.js 按场景重画。
dom = re.sub(r'(<div id="messages">).*?(</div>\s*<div class="scroll-fade")', r'\1\2', dom, count=1, flags=re.S)
(here / "index.html").write_text((here / "template.html").read_text().replace("__PANEL__", json.dumps(dom, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")))
print("index.html", len(dom))
