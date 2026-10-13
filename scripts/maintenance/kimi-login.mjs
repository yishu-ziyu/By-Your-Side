#!/usr/bin/env node
/**
 * 让 Pi 里的 Kimi 订阅登录（~/.pi/agent/auth.json 的 kimi-coding）一直有效，真实模型验收靠它借令牌。
 *
 *   npm run kimi:login     # 设备码登录：打印授权链接，在 Kimi 网页上点一次确认后写回 auth.json
 *   npm run kimi:keep      # 装后台定时任务：每 6 小时检查一次，快过期就续期；续不上时弹系统通知
 *   node scripts/maintenance/kimi-login.mjs            # 检查一次（定时任务跑的就是这个）
 *
 * 为什么要它：Kimi 的访问令牌只活约 15 分钟，刷新令牌每用一次就换新、旧的作废（10-14 实测）。
 * Pi 只在被使用时才续期；验收脚本以前把刷新令牌交给测试扩展，扩展自己一续期，Pi 手里那份就作废，只能重新网页确认。
 * 现在只有这里续期：在 Pi 自己的文件锁里做（AuthStorage.modify），和正在运行的 Pi 不会同时轮换；
 * 验收脚本经 renewKimi() 取一个新的访问令牌，交给测试扩展时不带刷新令牌。
 * 只碰 kimi-coding 一项；日志写在 ~/.sideagent/kimi-login.log，不记令牌内容。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const PROVIDER = "kimi-coding";
/** 定时任务每次都续期：访问令牌只活约 15 分钟，续期的目的是让刷新令牌一直在用、不闲置过期。 */
const RENEW_AHEAD_MS = Number.POSITIVE_INFINITY;
const LABEL = "com.byyourside.kimi-login";
const LOG = join(homedir(), ".sideagent", "kimi-login.log");

// Pi 没有从包入口导出 AuthStorage；按文件路径取它，用的是 Pi 自己的锁和读写。
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
    // 通知失败不影响结果，日志里有记录。
  }
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);

/**
 * 访问令牌离过期不到 aheadMs 就在锁里续期，返回当前有效的登录。验收脚本用它取令牌。
 * 没登录时返回 undefined；刷新令牌失效时抛出（错误信息含 unauthorized）。
 */
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
    // 刷新令牌本身失效才需要人；网络一时不通等下一轮再试，不打扰用户。
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
    // 设备码登录不需要终端输入；万一问到，按取消处理。
    prompt: async () => { throw new Error("设备码登录不需要输入"); },
  });
  await store.modify(PROVIDER, async (current) => ({ ...(current ?? {}), ...credential }));
  log(`设备码登录成功，令牌 ${hours(credential.expires - Date.now())} 小时后过期`);
  console.log(`登录好了，令牌 ${hours(credential.expires - Date.now())} 小时后过期。`);
}

function install() {
  const script = fileURLToPath(import.meta.url);
  // 后台任务读不到终端里的代理设置；装的时候把现在的代理一起写进去。
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

  try { execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" }); } catch { /* 第一次装时本来就没有 */ }
  execFileSync("launchctl", ["bootstrap", domain, target]);
  console.log(`已安装后台定时任务 ${LABEL}：开机和每 6 小时检查一次。日志：${LOG}`);
}

// 直接运行才执行命令；被验收脚本 import 时只提供 renewKimi。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--login")) await login();
  else if (process.argv.includes("--install")) install();
  else await check();
}
