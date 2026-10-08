"""沿用本轮真实侧栏结构与样式，只演示尚待决定的语音分流。"""
import json, pathlib, re
here = pathlib.Path(__file__).parent
repo = here.parents[2]
dom = (repo / "out/acceptance/session-recovery/welcome-premise/0.html").read_text()
dom = re.sub(r"<script\b.*?</script>", "", dom, flags=re.S)
css = (repo / "extension/src/sidepanel/styles.css").read_text().replace('@media (prefers-color-scheme: dark)', '@media not all')
dom = dom.replace('<link rel="stylesheet" href="styles.css">', f'<style>{css}:root{{color-scheme:light}}</style>')
dom = re.sub(r'<canvas id="starter-orb".*?</canvas>', '', dom)
(here / "index.html").write_text((here / "template.html").read_text().replace("__PANEL__", json.dumps(dom, ensure_ascii=False).replace("</", "<\\/")))
