#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const PROVIDER = "kimi-coding";
const RENEW_AHEAD_MS = Number.POSITIVE_INFINITY;
const LABEL = "com.byyourside.kimi-login";
const LOG = join(homedir(), ".sideagent", "kimi-login.log");

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { AuthStorage } = await import(pathToFileURL(join(dirname(piEntry), "core", "auth-storage.js")).href);
const store = AuthStorage.create();
const oauth = builtinModels().getProvider(PROVIDER)?.auth.oauth;

if (!oauth) throw new Error(`pi-ai 里没有 ${PROVIDER} 的登录方式`);

function log(line) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

function notify(text) {
  try {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "Kimi 登录"`]);
  } catch {
  }
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);

export async function renewKimi(aheadMs) {
  let result;

  await store.modify(PROVIDER, async (current) => {
    if (current?.type !== "oauth") return current;

    if (current.expires - Date.now() > aheadMs) { result = current;

 return current; }
    const fresh = await oauth.refresh(current, AbortSignal.timeout(60_000));
    result = { ...current, ...fresh };

    return result;
  });

  return result;
}

async function check() {
  let outcome = "";

  try {
    const current = await renewKimi(RENEW_AHEAD_MS);
    outcome = current ? `已续期，访问令牌 ${hours(current.expires - Date.now())} 小时后过期` : "missing";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dead = /unauthorized|invalid_grant/i.test(message);
    log(`续期失败：${message.slice(0, 200)}`);
    if (dead) notify("登录失效了：在终端运行 npm run kimi:login，网页上点一次确认。");
    console.error(`续期失败：${message}`);
    process.exitCode = 1;

    return;
  }

  if (outcome === "missing") {
    log("auth.json 里没有 Kimi 登录");
    notify("还没登录：在终端运行 npm run kimi:login。");
    console.error("auth.json 里没有 Kimi 登录，先运行 npm run kimi:login");
    process.exitCode = 1;

    return;
  }

  log(outcome);
  console.log(outcome);
}

async function login() {
  const credential = await oauth.login({
    signal: AbortSignal.timeout(16 * 60_000),
    notify(event) {
      if (event.type === "device_code") {
        console.log(`\n在浏览器打开这个链接，登录 Kimi 后点确认（15 分钟内有效）：\n\n  ${event.verificationUri}\n\n授权码：${event.userCode}\n等待确认中…`);
      }
    },
    prompt: async () => { throw new Error("设备码登录不需要输入"); },
  });
  await store.modify(PROVIDER, async (current) => ({ ...(current ?? {}), ...credential }));
  log(`设备码登录成功，令牌 ${hours(credential.expires - Date.now())} 小时后过期`);
  console.log(`登录好了，令牌 ${hours(credential.expires - Date.now())} 小时后过期。`);
}

function install() {
  const script = fileURLToPath(import.meta.url);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(https?|all|no)_proxy$/i.test(k)));
  env.NODE_USE_ENV_PROXY = "1";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string></array>
  <key>WorkingDirectory</key><string>${join(dirname(script), "..", "..")}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict></plist>
`;
  const target = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, plist);
  const domain = `gui/${process.getuid()}`;

  try { execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch {  }
  execFileSync("launchctl", ["bootstrap", domain, target]);
  console.log(`已安装后台定时任务 ${LABEL}：开机和每 6 小时检查一次。日志：${LOG}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--login")) await login();
  else if (process.argv.includes("--install")) install();
  else await check();
}
