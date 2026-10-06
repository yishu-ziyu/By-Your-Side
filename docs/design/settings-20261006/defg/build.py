"""把 BYS 原样 styles.css + settings.css + 原型 CSS/JS 打成一个可双击打开的 html。"""
import os, subprocess, pathlib, shlex
R = pathlib.Path(__file__).parent
ESB = shlex.split(os.environ.get("ESBUILD", "npx --yes esbuild@0.28.2"))
js = subprocess.run([*ESB, str(R/"src/main.js"), "--bundle", "--format=iife", "--target=chrome120", "--loader:.svg=dataurl", "--minify-syntax"], capture_output=True, text=True, check=True).stdout
css = "\n".join((R/"src"/f).read_text() for f in ["bys-styles.css", "bys-settings.css", "proto.css"])
html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模型与语音 · 参考源码版 D/E/F/G · By Your Side 原型</title>
<style>{css}</style></head>
<body class="settings-page"><main id="settings"></main>
<script>{js.replace('</script>', '<\\/script>')}</script></body></html>"""
out = R/"bys-settings-refs.html"; out.write_text(html)
print("wrote", out, len(html)//1024, "KB")
