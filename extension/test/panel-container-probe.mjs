/**
 * PR #3 R2 第三层证据：ChromeMain 内真实 side panel 容器的只读探针。
 *
 * 严格只读：列出 /json/list 找现存的 sidepanel.html 目标（用户已打开的侧栏），
 * 经其 webSocketDebuggerUrl 连接后只执行 Runtime.evaluate 查询 DOM（芯片文本、
 * 能力标签 hidden、核心控件几何）。不点击、不导航、不新建标签、不改任何状态。
 * 若侧栏未打开：如实输出 no-target 并以退出码 2 结束（不是失败，是本轮不可得）。
 *
 * 用法：node extension/test/panel-container-probe.mjs
 */
import { discoverChromeMain } from "../../scripts/acceptance/discover.mjs";

const extId = process.argv[2]; // 可选：覆盖扩展 ID

const hit = await discoverChromeMain();
if (!hit) {
  console.error("no-target: ChromeMain 未运行");
  process.exit(2);
}
const list = await (await fetch(`http://127.0.0.1:${hit.port}/json/list`)).json();
const panel = list.find(
  (t) => t.type === "page" && /\/sidepanel\.html$/.test(t.url) && (!extId || t.url.startsWith(`chrome-extension://${extId}/`)),
);
if (!panel) {
  console.error(`no-target: ChromeMain（:${hit.port}）当前没有打开的 sidepanel.html 目标（侧栏关闭即如此）`);
  process.exit(2);
}

const ws = new WebSocket(panel.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
});
const call = (id, expr) =>
  new Promise((res) => {
    const onMsg = (raw) => {
      const m = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        res(m.result?.result?.value);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
  });

const FABRICATED = ["支持档位调节", "内置深度思考", "极速直接响应"];
const expr = `(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)}; };
  const inView = (r) => r && r.w>0 && r.h>0 && r.right<=window.innerWidth && r.bottom<=window.innerHeight;
  const tags = ${JSON.stringify(FABRICATED)};
  return {
    url: location.href,
    viewport: window.innerWidth + "x" + window.innerHeight,
    scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    chip: document.getElementById("model-name")?.textContent ?? null,
    chipTagHidden: document.getElementById("model-reasoning-tag")?.hidden ?? null,
    fabricatedInPage: tags.some((t) => document.body.textContent.includes(t)),
    input: rect("#input"), send: rect("#send-btn"), modelBtn: rect("#model-btn"),
    inputVisible: inView(rect("#input")), sendVisible: inView(rect("#send-btn")), modelBtnVisible: inView(rect("#model-btn")),
  };
})()`;
const snap = await call(1, expr);
ws.close();
console.log(JSON.stringify({ when: new Date().toISOString(), target: panel.url, snapshot: snap }, null, 2));
const s = snap;
const ok =
  s &&
  s.chipTagHidden === true &&
  !s.fabricatedInPage &&
  s.inputVisible &&
  s.sendVisible;
console.log(ok ? "PASS 真实容器：无能力标签 + 核心控件完整可见" : "FAIL 见 snapshot");
process.exit(ok ? 0 : 1);
