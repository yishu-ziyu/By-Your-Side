import { removeWebRtc } from "./sandbox-offline.js";

type MiniAppMessage = { html: string; state: string | null; maxHeight?: number };

const DEFAULT_MAX_HEIGHT = 720;

const BASE = `<style>
:root { color-scheme: light dark; --bys-text: #1d1d1b; --bys-muted: #6b6b66; --bys-border: #e3e3df; --bys-subtle: #f3f3f1; --bys-accent: #2c5fb3; --bys-good: #2f7a4f; }
@media (prefers-color-scheme: dark) { :root { --bys-text: #ececea; --bys-muted: #9a9a94; --bys-border: #3a3a36; --bys-subtle: #2a2a27; --bys-accent: #7fa6e8; --bys-good: #6cc28d; } }
html, body { margin: 0; background: transparent; color: var(--bys-text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
body { padding: 12px; overflow-x: hidden; }
*, *::before, *::after { box-sizing: border-box; }
</style>`;

const bridge = (state: string | null, maxHeight: number) => `<script>
(() => {
  const post = (data) => parent.postMessage(Object.assign({ miniApp: data.kind }, data), "*");
  let saved = null;
  let nextCall = 0;
  const calls = new Map();
  addEventListener("message", (e) => {
    const reply = e.source === parent && e.data && e.data.miniAppReply;
    const call = reply && calls.get(reply);
    if (!call) return;
    calls.delete(reply);
    if (e.data.ok) call.resolve(e.data.value); else call.reject(new Error(e.data.error || "页面没有响应"));
  });
  const ask = (op, seconds) => new Promise((resolve, reject) => {
    const id = ++nextCall;
    calls.set(id, { resolve, reject });
    post({ kind: "page", id, op, seconds });
  });
  try { saved = ${JSON.stringify(state)} === null ? null : JSON.parse(${JSON.stringify(state)}); } catch { saved = null; }
  window.bys = Object.freeze({
    state: saved,
    save(value) {
      let text;
      try { text = JSON.stringify(value ?? null); } catch (e) { fail("bys.save 存不下：" + e); return; }
      // 超过上限就不存，侧栏留着上一份；截断的 JSON 读不回来，会把好的那份也盖掉。
      if (text.length > 50000) { fail("bys.save 存不下：超过 50KB"); return; }
      post({ kind: "save", state: text });
    },
    say(text) { post({ kind: "draft", text: String(text ?? "").slice(0, 500) }); },
    send(text) { post({ kind: "send", text: String(text ?? "").slice(0, 3000) }); },
    page: Object.freeze({ captions: () => ask("captions"), read: () => ask("read"), seek: (seconds) => ask("seek", Number(seconds)), jump: (section) => ask("jump", Number(section)) }),
  });
  const fail = (message) => post({ kind: "error", message: String(message).slice(0, 300) });
  addEventListener("error", (e) => { if (!/^ResizeObserver loop/.test(e.message)) fail(e.message || "脚本出错"); });
  addEventListener("unhandledrejection", (e) => fail((e.reason && e.reason.message) || e.reason || "脚本出错"));
  // 量 body 自己的高（含内边距）：量整页的 scrollHeight 会差一两像素，框里就多出一条滚动条。
  // 没超过侧栏给的最高时框和内容一样高，差的一两像素不该变成一条滚动条；超过了才让它滚。
  const height = () => {
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    document.documentElement.style.overflowY = h <= ${maxHeight} ? "hidden" : "auto";
    post({ kind: "height", h });
  };
  addEventListener("load", () => {
    new ResizeObserver(height).observe(document.body);
    height();
    setTimeout(() => {
      const body = document.body;
      const visible = body && (body.innerText.trim() || body.querySelector("canvas,svg,img,input,button,select,textarea,video"));
      if (!visible) fail("小程序是空白的");
    }, 1500);
  });
})();
</script>`.replace(/<\/(?!script>$)/g, "<\\/");

let written = false;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || written) return;
  const { html, state, maxHeight } = event.data as MiniAppMessage;

  written = true;
  removeWebRtc();
  document.open();
  document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${BASE}${bridge(typeof state === "string" ? state : null, typeof maxHeight === "number" ? maxHeight : DEFAULT_MAX_HEIGHT)}</head><body>${String(html)}</body></html>`);
  document.close();
});

window.parent.postMessage({ miniApp: "ready" }, "*");
