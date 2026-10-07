/**
 * P1/P2 共用驱动：构建实验扩展 → 无头 Chrome（--headless=new）加载 → 经 CDP 调页面或 offscreen 文档里的 globalThis.probe.*。
 * 改写自 ../pi1-durable/drive.mjs。结果写 out/pi1-rebuild/。
 * 凭据：~/.pi/agent/auth.json["openai-codex"] 的访问令牌，剩余不足 3 小时就停（BLOCKED），从不刷新、从不打印。
 */
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--headless")) { console.error("只在无头模式下运行：加 --headless"); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));

export const out = path.join(here, "../../../out/pi1-rebuild");

const extDir = path.join(out, "ext");

mkdirSync(extDir, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const save = (name, obj) => { writeFileSync(path.join(out, name), JSON.stringify(obj, null, 2)); console.log(`→ out/pi1-rebuild/${name}`); };

// ---------- 凭据（3 小时保护，不刷新） ----------
const login = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];

if (!login || login.expires - Date.now() < 3 * 3_600_000) { console.log("BLOCKED: openai-codex 令牌缺失或 3 小时内过期"); process.exit(3); }

const cred = JSON.stringify({ access: login.access, expires: login.expires, accountId: login.accountId });

// ---------- 构建扩展 ----------
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

const extId = Array.from(createHash("sha256").update(publicKey).digest("hex").slice(0, 32), (c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

await esbuild.build({ entryPoints: [path.join(here, "ext-src/page.ts"), path.join(here, "ext-src/background.ts")], outdir: extDir, bundle: true, platform: "browser", target: "chrome120", format: "esm", external: ["node:*"], define: { "process.env": "{}" }, logLevel: "warning" });

copyFileSync(path.join(here, "ext-src/page.html"), path.join(extDir, "page.html"));

writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "pi1-rebuild probe", version: "0.0.1", key: publicKey.toString("base64"), background: { service_worker: "background.js", type: "module" }, host_permissions: ["https://chatgpt.com/*"], permissions: ["unlimitedStorage", "offscreen"] }, null, 2));

// ---------- 无头 Chrome ----------
function chromePath() {
  if (process.env.EGO_ACCEPTANCE_CHROME) return process.env.EGO_ACCEPTANCE_CHROME;
  const root = path.join(homedir(), "Library/Caches/ms-playwright");
  const v = readdirSync(root).flatMap((n) => (/^chromium-\d+$/.test(n) ? [n] : [])).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));

  for (const n of v) {
    const p = path.join(root, n, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

    if (existsSync(p)) return p;
  }

  throw new Error("找不到 Chrome for Testing");
}

const profile = mkdtempSync(path.join(tmpdir(), "pi1-rebuild-"));

const chrome = spawn(chromePath(), ["--headless=new", "--use-mock-keychain", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,900", "about:blank"], { stdio: "ignore" });

let port;

for (let i = 0; i < 100 && !port; i++) { await sleep(200); port = existsSync(path.join(profile, "DevToolsActivePort")) && readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

const ws = new WebSocket(version.webSocketDebuggerUrl);

await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;

const pending = new Map();

ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);

  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (msg) => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function evalIn(session, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);

  if (r.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);

  return r.result.value;
}

export async function waitFor(check, ms, what) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await check().catch(() => undefined);

    if (v) return v;
    await sleep(150);
  }

  throw new Error(`超时：${what}`);
}

/** 连上一个已存在的目标（按 URL 结尾和类型找），返回 { call(fn, ...args) }。 */
async function attach(suffix, types, global, exclude) {
  const target = await waitFor(async () => (await send("Target.getTargets")).targetInfos.find((t) => types.includes(t.type) && t.url.endsWith(suffix) && t.targetId !== exclude), 15_000, `目标 ${suffix}`);
  const session = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;

  await waitFor(() => evalIn(session, `!!globalThis.${global}`), 15_000, `${global} 就绪`);

  return { type: target.type, targetId: target.targetId, call: (fn, ...args) => evalIn(session, `${global}.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`) };
}

/** 页面接口；凭据单独注入，出错时不把含令牌的表达式带进报错。 */
async function withSetup(page) {
  await page.call("setup", JSON.parse(cred)).catch(() => { throw new Error("setup 失败"); });

  return page;
}

/** 普通扩展标签页。 */
export async function openTab() {
  await send("Target.createTarget", { url: `chrome-extension://${extId}/page.html` });

  return withSetup(await attach("/page.html", ["page"], "probe"));
}

/** service worker 的 offscreen 控制接口。 */
export const serviceWorker = () => attach("/background.js", ["service_worker"], "offscreen");

/** offscreen 文档（Chrome 把它报成 background_page 或 other 类型的目标）。 */
export const openOffscreen = async (exclude) => withSetup(await attach("/page.html", ["background_page", "other", "page"], "probe", exclude));

export async function shutdown() {
  ws.close();
  chrome.kill("SIGTERM");
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
