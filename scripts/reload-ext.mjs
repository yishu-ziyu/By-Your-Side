#!/usr/bin/env node
/**
 * 热重载开发中的扩展（免重启 Chrome）：
 * 新开一个 chrome://extensions 后台标签 → 在页面 shadow DOM 里点本扩展的「重新加载」→ 关标签。
 * 需要 Chrome 以 --remote-debugging-port=9222 运行（可用 CDP_PORT 覆盖端口）。
 * 只适配 macOS。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDP = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;

/** manifest key（base64 SPKI DER）→ 扩展 ID（与 install-host.mjs 同算法）。 */
function extensionIdFromKey(key) {
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join("");
}

const manifest = JSON.parse(readFileSync(join(repoRoot, "extension/manifest.json"), "utf8"));
if (!manifest.key) {
  console.error("extension/manifest.json 缺少 key 字段，无法确定扩展 ID");
  process.exit(1);
}
const EXT_ID = extensionIdFromKey(manifest.key);

const ver = await (await fetch(`${CDP}/json/version`)).json().catch(() => null);
if (!ver) {
  console.error(`连不上 ${CDP}——Chrome 需要带 --remote-debugging-port 启动`);
  process.exit(1);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res) => pending.set(id, res));
}

// 注意两点（2026-09 实测）：
// - 外部直接开 chrome-extension:// 页面会被 Chrome 拦（ERR_BLOCKED_BY_CLIENT），不能靠临时扩展页调 chrome.runtime.reload()；
// - 已开的旧 chrome://extensions 标签常被冻结，evaluate 会挂起——必须新建标签（新渲染进程）。
const { result: t } = await send("Target.createTarget", { url: "chrome://extensions/", active: false });
await new Promise((r) => setTimeout(r, 2500));
const { result: att } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });

const r = await send("Runtime.evaluate", {
  expression: `(() => {
    const mgr = document.querySelector('extensions-manager');
    if (!mgr || !mgr.shadowRoot) return 'extensions 页面未就绪';
    const list = mgr.shadowRoot.querySelector('extensions-item-list');
    if (!list || !list.shadowRoot) return 'extensions 列表未就绪';
    const items = [...list.shadowRoot.querySelectorAll('extensions-item')];
    for (const item of items) {
      const id = item.id || item.getAttribute('data-id') || (item.data && item.data.id);
      if (id === '${EXT_ID}') {
        const btn = item.shadowRoot.querySelector('#dev-reload-button, #reload-button');
        if (!btn) return '找不到 reload 按钮（扩展被禁用？）';
        btn.click();
        return 'ok';
      }
    }
    return '扩展 ${EXT_ID} 未安装';
  })()`,
  returnByValue: true,
}, att.sessionId);
const outcome = r.result?.result?.value ?? JSON.stringify(r.result);

await new Promise((r2) => setTimeout(r2, 800));
await send("Target.closeTarget", { targetId: t.targetId });

if (outcome === "ok") {
  console.log(`扩展 ${EXT_ID} 已重载（新代码生效）`);
} else {
  console.error(`重载失败：${outcome}`);
  process.exit(1);
}
process.exit(0);
