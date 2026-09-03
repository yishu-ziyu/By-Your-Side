#!/usr/bin/env node
/**
 * 安装 native messaging host：
 * 1. 由 extension/manifest.json 的固定 key 算出扩展 ID
 * 2. 生成 agent/native-host.sh（Chrome 直接 exec 的 wrapper，绝对路径指向本仓库）
 * 3. 把 host manifest 写到 Chrome 的 NativeMessagingHosts 目录
 * 只适配 macOS。重复执行幂等。
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.sideagent.host";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** manifest key（base64 SPKI DER）→ 扩展 ID（SHA256 前 16 字节，每 nibble 映射 a-p）。 */
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
const extensionId = extensionIdFromKey(manifest.key);

// wrapper 脚本必须放在非 TCC 保护目录（~/.sideagent/）：
// Chrome 没有「桌面」文件夹权限时，bash 读 Desktop 上的脚本会被内核 Sandbox 拒掉
// （现象：面板报 "Native host has exited"，进程根本没起来）。
// 仓库代码被 node 读不受影响；wrapper 本身必须在保护区外。
const wrapperPath = join(homedir(), ".sideagent", "native-host.sh");
const wrapper = [
  "#!/bin/bash",
  "# 由 npm run install:host 生成，勿手改；路径变化后重跑安装脚本",
  "# stderr 落文件：Chrome 会吞掉 host 的 stderr",
  `exec "${process.execPath}" "${join(repoRoot, "node_modules/tsx/dist/cli.mjs")}" "${join(repoRoot, "agent/src/main.ts")}" 2>> "$HOME/.sideagent/wrapper-err.log"`,
  "",
].join("\n");
mkdirSync(join(homedir(), ".sideagent"), { recursive: true });
writeFileSync(wrapperPath, wrapper);
chmodSync(wrapperPath, 0o755);

const hostManifestDir = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
// ── 目标 Chrome user-data-dir 列表 ─────────────────────────────────
// Chrome 以自定义 --user-data-dir 运行时，只认 <user-data-dir>/NativeMessagingHosts，
// 标准目录的清单对它无效。所以：默认装标准目录；同时探测正在运行的 Chrome 实例的
// --user-data-dir；也可用 --user-data-dir <path> 显式指定。

function runningChromeUserDataDirs() {
  let out = "";
  try {
    out = execSync("ps aux", { encoding: "utf8" });
  } catch {
    return [];
  }
  const dirs = new Set();
  // 只认正式 Chrome（Google Chrome.app）的命令行；ps 输出参数不带引号，
  // 路径可能含空格：取到下一个 -- 参数或行尾为止
  for (const line of out.split("\n")) {
    if (!line.includes("Google Chrome.app/Contents/MacOS/Google Chrome")) continue;
    const m = line.match(/--user-data-dir=(.+?)(?:\s+--\w|$)/);
    if (!m) continue;
    const dir = m[1].replace(/^"|"$/g, "").trim();
    if (dir.startsWith("/")) dirs.add(dir);
  }
  return [...dirs];
}

const cliDirIndex = process.argv.indexOf("--user-data-dir");
const userDataDirs = new Set([join(homedir(), "Library/Application Support/Google/Chrome")]);
if (cliDirIndex !== -1 && process.argv[cliDirIndex + 1]) {
  userDataDirs.add(process.argv[cliDirIndex + 1]);
}
for (const dir of runningChromeUserDataDirs()) userDataDirs.add(dir);

const hostManifest = JSON.stringify(
  {
    name: HOST_NAME,
    description: "SideAgent 伴随进程",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  },
  null,
  2,
) + "\n";

for (const userDataDir of userDataDirs) {
  const hostManifestDir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(hostManifestDir, { recursive: true });
  writeFileSync(join(hostManifestDir, `${HOST_NAME}.json`), hostManifest);
  console.log(`native host 已安装：${hostManifestDir}/${HOST_NAME}.json`);
}

console.log(`  扩展 ID: ${extensionId}（由 manifest key 推导）`);
console.log(`  wrapper: ${wrapperPath}`);
console.log("下一步：完全退出 Chrome（Cmd+Q，native host 清单只在启动时扫描）后重开，打开侧边栏即可自动连接。");
