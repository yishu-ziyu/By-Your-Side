/**
 * P3(b) 驱动：构建实验扩展 → 无头 Chrome（--headless=new）加载 → 经 CDP 调页面里的 probe.*，每个服务商一个新页面。
 * 用法：node drive.mjs --headless。结果写 out/pi1-rebuild/providers/stream-result.json。
 * 凭据：~/.pi/agent/auth.json，只在运行时注入页面，从不刷新、从不打印、从不写文件。codex 令牌剩余不足 3 小时、其他登录令牌已过期都标 BLOCKED。
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

const out = path.join(here, "../../../../out/pi1-rebuild/providers");

const extDir = path.join(out, "ext");

mkdirSync(extDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const auth = JSON.parse(readFileSync(path.join(homedir(), ".pi/agent/auth.json"), "utf8"));

// 每家：服务商、模型、凭据怎么注入、什么情况下 BLOCKED。
const plan = [
  { name: "openai-codex", provider: "openai-codex", model: "gpt-6-luna", minMs: 3 * 3_600_000 },
  { name: "kimi-coding", provider: "kimi-coding", model: "kimi-for-coding", minMs: 0 },
  { name: "deepseek", provider: "deepseek", model: "deepseek-flash" },
  { name: "custom-openai-compatible", provider: "custom-probe", model: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1", authKey: "deepseek" },
  { name: "xai", provider: "xai", model: "grok-4.3", minMs: 0 },
  { name: "github-copilot", provider: "github-copilot", model: "claude-haiku-4.5" },
];

await esbuild.build({ entryPoints: [path.join(here, "ext-src/probe.ts")], outdir: extDir, bundle: true, platform: "browser", target: "chrome120", format: "esm", external: ["node:*"], define: { "process.env": "{}" }, logLevel: "warning",
  // 1.0.4 的 package exports 不再导出 ./auth/oauth/*，只能指到 dist 文件。
  alias: { "@earendil-works/pi-ai/auth/oauth": path.join(here, "node_modules/@earendil-works/pi-ai/dist/auth/oauth") },
  plugins: [{ name: "node-http-shim", setup: (b) => { b.onResolve({ filter: /^node:http$/ }, () => ({ path: "node-http", namespace: "shim" })); b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: "export const createServer = () => { throw new Error('no local OAuth callback server in the browser'); };" })); } }] });

copyFileSync(path.join(here, "ext-src/probe.html"), path.join(extDir, "probe.html"));

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

const extId = Array.from(createHash("sha256").update(publicKey).digest("hex").slice(0, 32), (c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "pi1 providers probe", version: "0.0.1", key: publicKey.toString("base64"), host_permissions: ["https://chatgpt.com/*", "https://api.kimi.com/*", "https://api.deepseek.com/*", "https://api.x.ai/*", "https://api.individual.githubcopilot.com/*"], permissions: ["unlimitedStorage"] }, null, 2));

function chromePath() {
  if (process.env.EGO_ACCEPTANCE_CHROME) return process.env.EGO_ACCEPTANCE_CHROME;

  const root = path.join(homedir(), "Library/Caches/ms-playwright");

  const v = readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));

  for (const n of v) {
    const p = path.join(root, n, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

    if (existsSync(p)) return p;
  }

  throw new Error("找不到 Chrome for Testing");
}

const profile = mkdtempSync(path.join(tmpdir(), "pi1-prov-"));

const chrome = spawn(chromePath(), ["--headless=new", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

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

async function openPage() {
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/probe.html` });

  const session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

  await send("Page.enable", {}, session);

  for (let i = 0; i < 100; i++) {
    const r = await send("Runtime.evaluate", { expression: "!!globalThis.probe", returnByValue: true }, session);

    if (r.result.value) return { session, targetId };

    await sleep(100);
  }

  throw new Error("probe 页面没就绪");
}

// 表达式可能含凭据：出错时只报固定文字。
async function evalPage(session, expression, secret = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);

  if (r.exceptionDetails) throw new Error(secret ? "页面调用失败（表达式含凭据，已隐去）" : `页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);

  return r.result.value;
}

const results = {};

try {
  for (const p of plan) {
    const entry = auth[p.authKey ?? p.provider];

    const row = { provider: p.provider, model: p.model };
    results[p.name] = row;

    if (p.provider === "github-copilot") { row.status = "BLOCKED"; row.reason = "no credential (by design)"; continue; }

    if (!entry) { row.status = "BLOCKED"; row.reason = "no credential in auth.json"; continue; }

    let cred;

    if (entry.type === "api_key") cred = { type: "api_key", key: entry.key };
    else {
      const left = entry.expires - Date.now();
      row.tokenHoursLeft = Math.round(left / 360_000) / 10;

      if (p.minMs !== undefined && left < p.minMs) {
        // 不刷新。codex 不足 3 小时即停；其他登录令牌已过期时，只把过期令牌原样发一次，看请求能否到达服务商（不算通过）。
        if (p.provider === "openai-codex") { row.status = "BLOCKED"; row.reason = "token expires within 3h"; continue; }

        row.expiredTokenSentOnce = true;
      }

      cred = { type: "oauth", access: entry.access, refresh: "probe-no-refresh", expires: left > 600_000 ? entry.expires : Date.now() + 3_600_000 };

      if (entry.accountId) cred.accountId = entry.accountId;
    }

    const { session, targetId } = await openPage();

    await evalPage(session, `probe.setup(${JSON.stringify(p.provider)}, ${JSON.stringify(cred)})`, true);

    const r = await evalPage(session, `probe.run(${JSON.stringify(p.provider)}, ${JSON.stringify(p.model)}, ${JSON.stringify(p.baseUrl ?? null)} ?? undefined)`);

    Object.assign(row, r);

    const rejected = /\b40[13]\b|invalid_authentication|Authentication Fails|could not be validated/.test(r.error ?? "");

    row.status = r.ok ? "OK" : row.expiredTokenSentOnce || rejected ? "BLOCKED" : "FAIL";

    if (row.status === "BLOCKED" && rejected && !row.expiredTokenSentOnce) row.reason = "provider rejected the stored credential (401/403); request path reached the API";

    if (row.status === "BLOCKED" && row.expiredTokenSentOnce) row.reason = "login token already expired; not refreshed (request result shown for reference)";

    await send("Target.closeTarget", { targetId });

    console.log(p.name, row.status, row.firstTextMs ?? "-", row.totalMs ?? "-", row.error ?? "");
  }
} catch (e) {
  console.error("失败：", e.message);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(out, "stream-result.json"), JSON.stringify(results, null, 2));

  ws.close();

  chrome.kill("SIGTERM");

  await sleep(500);

  rmSync(profile, { recursive: true, force: true });
}
