/**
 * 回答里小程序的沙箱页：manifest 的 sandbox.pages，不透明来源，没有 chrome.* 接口。
 * 本页自己的 CSP（mini-app.html 的 meta）不许联网、不许加载外部资源、不许再嵌页面；整页写入后这条 CSP 仍管着写进来的内容
 * （10-19 小实验 mini-app-probe：fetch、图片、脚本、样式、表单、弹窗都被拦）。自己跳到外面网址由侧栏的 frame-src 拦。
 * 写进去的程序前面先放一段桥：bys.state / bys.save / bys.say、报错、空白、高度都经 postMessage 交给侧栏，侧栏只当它们是不可信的话。
 */
type MiniAppMessage = { html: string; state: string | null };

/** 侧栏给小程序框的最高高度（answer-cards.ts 的 APP_MAX_HEIGHT）。 */
const MAX_HEIGHT = 720;

const BASE = `<style>
:root { color-scheme: light dark; --bys-text: #1d1d1b; --bys-muted: #6b6b66; --bys-border: #e3e3df; --bys-subtle: #f3f3f1; --bys-accent: #2c5fb3; --bys-good: #2f7a4f; }
@media (prefers-color-scheme: dark) { :root { --bys-text: #ececea; --bys-muted: #9a9a94; --bys-border: #3a3a36; --bys-subtle: #2a2a27; --bys-accent: #7fa6e8; --bys-good: #6cc28d; } }
html, body { margin: 0; background: transparent; color: var(--bys-text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
body { padding: 12px; overflow-x: hidden; }
*, *::before, *::after { box-sizing: border-box; }
</style>`;

/** 桥：在程序之前运行。state 是侧栏存过的那份（字符串化的 JSON），程序没存过时为 null。 */
const bridge = (state: string | null) => `<script>
(() => {
  const post = (data) => parent.postMessage(Object.assign({ miniApp: data.kind }, data), "*");
  let saved = null;
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
  });
  const fail = (message) => post({ kind: "error", message: String(message).slice(0, 300) });
  addEventListener("error", (e) => fail(e.message || "脚本出错"));
  addEventListener("unhandledrejection", (e) => fail((e.reason && e.reason.message) || e.reason || "脚本出错"));
  // 量 body 自己的高（含内边距）：量整页的 scrollHeight 会差一两像素，框里就多出一条滚动条。
  // 没超过侧栏给的最高时框和内容一样高，差的一两像素不该变成一条滚动条；超过了才让它滚。
  const height = () => {
    const h = Math.ceil(document.body.getBoundingClientRect().height);
    document.documentElement.style.overflowY = h <= ${MAX_HEIGHT} ? "hidden" : "auto";
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
  // SAFETY: 上一行已确认发送方是嵌着本页的侧栏，它只发 {html, state}（answer-cards.ts mountApp）。
  const { html, state } = event.data as MiniAppMessage;

  written = true;
  document.open();
  document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${BASE}${bridge(typeof state === "string" ? state : null)}</head><body>${String(html)}</body></html>`);
  document.close();
});

window.parent.postMessage({ miniApp: "ready" }, "*");
