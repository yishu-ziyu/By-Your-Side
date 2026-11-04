#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const CDP = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;

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
  const sessionExtra = sessionId ? { sessionId } : {};
  ws.send(JSON.stringify({ id, method, params, ...sessionExtra }));

  return new Promise((res) => pending.set(id, res));
}

const { result: t } = await send("Target.createTarget", { url: "chrome://extensions/", background: true });

const { result: att } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });

const click = () => send("Runtime.evaluate", {
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

let outcome = "";

for (const until = Date.now() + 20_000; ;) {
  await new Promise((r2) => setTimeout(r2, 500));
  const r = await click();
  outcome = r.result?.result?.value ?? JSON.stringify(r.result);

  if (!/未就绪|未安装/.test(outcome) || Date.now() > until) break;
}

await new Promise((r2) => setTimeout(r2, 800));

await send("Target.closeTarget", { targetId: t.targetId });

if (outcome === "ok") {
  console.log(`扩展 ${EXT_ID} 已重载（新代码生效）`);
} else {
  console.error(`重载失败：${outcome}`);
  process.exit(1);
}

process.exit(0);
