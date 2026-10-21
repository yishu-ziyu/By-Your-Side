#!/usr/bin/env node
/**
 * 模拟用户模式开关（日常 Chrome，经 CDP 9222 写扩展存储）：代理用 LCU 替用户试用时打开。
 *   npm run self-use -- on [小时，默认 6]   npm run self-use -- off   npm run self-use -- status
 * 打开期间扩展不写记忆、不记过往任务和浏览习惯，诊断里标 self-use；到点自动失效，忘了关也不会一直挡着用户自己的记忆。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CDP = `http://127.0.0.1:${process.env.CDP_PORT ?? 9222}`;
const KEY = "sideagent_self_use";
const [command = "status", hoursArg] = process.argv.slice(2);

const der = Buffer.from(JSON.parse(readFileSync(join(repo, "extension/manifest.json"), "utf8")).key, "base64");
const id = [...createHash("sha256").update(der).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");

const version = await (await fetch(`${CDP}/json/version`)).json().catch(() => null);

if (!version) { console.error(`连不上 ${CDP}：日常 Chrome 要带 --remote-debugging-port 启动`); process.exit(1); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.addEventListener("open", ok); ws.addEventListener("error", fail); });
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", ev => { const m = JSON.parse(String(ev.data)); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise(ok => { const n = ++seq; waiting.set(n, ok); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });

// 扩展自己的页面里才有 chrome.storage：后台、offscreen 或侧栏，哪个醒着用哪个。
const { result } = await send("Target.getTargets");
const prefix = `chrome-extension://${id}/`;
const target = ["service_worker", "other", "page"].flatMap(type => result.targetInfos.filter(t => t.type === type && t.url.startsWith(prefix)))[0];

if (!target) { console.error("扩展的页面都没醒着：打开一次侧栏再试"); process.exit(1); }
const { result: attached } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const hours = Number(hoursArg ?? 6);
const write = command === "on" ? `chrome.storage.local.set({ ${KEY}: { until: Date.now() + ${Math.max(0.1, hours)} * 3600_000 } })`
  : command === "off" ? `chrome.storage.local.remove(${JSON.stringify(KEY)})` : "Promise.resolve()";
const { result: evaluated } = await send("Runtime.evaluate", {
  expression: `(${write}).then(() => chrome.storage.local.get(${JSON.stringify(KEY)})).then(v => JSON.stringify(v[${JSON.stringify(KEY)}] ?? null))`,
  awaitPromise: true, returnByValue: true,
}, attached.sessionId);
const value = JSON.parse(evaluated?.result?.value ?? "null");
console.log(value && value.until > Date.now() ? `模拟用户模式：开，到 ${new Date(value.until).toLocaleString("zh-CN")} 自动关` : "模拟用户模式：关");
ws.close();
