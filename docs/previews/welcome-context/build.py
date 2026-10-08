"""复用真实欢迎页 DOM 和产品样式；模型文案来自本轮实测，不进入产品。"""
import json, pathlib, re
here = pathlib.Path(__file__).parent
repo = here.parents[2]
data = json.loads((repo / "out/acceptance/session-recovery/welcome-compare.json").read_text())
panels = []
for i in range(3):
    dom = (repo / f"out/acceptance/session-recovery/welcome-premise/{i}.html").read_text()
    dom = re.sub(r"<script\b.*?</script>", "", dom, flags=re.S)
    css = (repo / "extension/src/sidepanel/styles.css").read_text().replace('@media (prefers-color-scheme: dark)', '@media not all')
    dom = dom.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}</style>')
    dom = re.sub(r'<canvas id="starter-orb".*?</canvas>', '<video id="starter-orb" aria-hidden="true" autoplay muted loop playsinline src="media/dusk.mp4"></video>', dom)
    dom = dom.replace('</head>', '<style>:root{color-scheme:light}#starter-orb{border-radius:50%;object-fit:cover}@media(prefers-reduced-motion:reduce){#starter-orb{visibility:hidden}}</style></head>')
    panels.append(dom)
safe = lambda value: json.dumps(value, ensure_ascii=False).replace("</", "<\\/")
(here / "index.html").write_text((here / "template.html").read_text().replace("__DATA__", safe(data)).replace("__PANELS__", safe(panels)))
