// 长回答成本：现在每 32ms 整段 marked+DOMPurify+innerHTML 一次；改后每拍只追加/重渲染当前段。
import { createRequire } from "module";
const require = createRequire("/workspace/By-Your-Side/package.json");
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await browser.newPage();
await page.goto("file:///workspace/bys-stream-proto/panel.html?v=cur&wait=1");
const r = await page.evaluate(() => {
  const para = window.BYS_STREAM.TEXT.split("\n\n");
  const out = {};
  for (const n of [1000, 3000, 8000]) {
    let md = ""; let i = 0; while (md.length < n) md += para[i++ % 3] + "\n\n";
    const host = document.createElement("div"); host.className = "msg assistant markdown"; document.getElementById("messages").append(host);
    const render = (t) => DOMPurify.sanitize(marked.parse(t, { async: false }));
    let t0 = performance.now(); for (let k = 0; k < 20; k++) { host.innerHTML = render(md); host.offsetHeight; } const full = (performance.now() - t0) / 20;
    const lastBlock = md.trim().split("\n\n").pop();
    t0 = performance.now(); for (let k = 0; k < 20; k++) { const tpl = document.createElement("template"); tpl.innerHTML = render(lastBlock); host.lastElementChild.replaceWith(...tpl.content.childNodes); host.offsetHeight; } const block = (performance.now() - t0) / 20;
    out[n] = { fullRenderMs: +full.toFixed(2), blockRenderMs: +block.toFixed(2), framesAt45cps: Math.round(n / 45 / 0.032) };
    host.remove();
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
