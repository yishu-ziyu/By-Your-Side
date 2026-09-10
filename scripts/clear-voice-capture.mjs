#!/usr/bin/env node
/**
 * 一键清空本机语音记录（默认遵循保留策略的目录 `~/.sideagent/voice-capture/`）。
 * 先打印将要删除的路径与总量，再删除目录内容；目录本身保留。
 * 用法：node scripts/clear-voice-capture.mjs [--root <dir>] [--dry-run]
 */
import {existsSync, readdirSync, rmSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join, resolve} from "node:path";

const argv = process.argv.slice(2);
let root = join(homedir(), ".sideagent", "voice-capture");
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") root = resolve(argv[++i] ?? "");
  else if (argv[i] === "--dry-run") dryRun = true;
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("用法：node scripts/clear-voice-capture.mjs [--root <dir>] [--dry-run]");
    process.exit(0);
  } else {
    console.error(`未知参数：${argv[i]}`);
    process.exit(1);
  }
}

const treeBytes = (path) => {
  let total = 0;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    total += statSync(child).isDirectory() ? treeBytes(child) : statSync(child).size;
  }
  return total;
};

if (!existsSync(root)) {
  console.log(`语音记录目录不存在，无需清空：${root}`);
  process.exit(0);
}

const entries = readdirSync(root).map((entry) => {
  const path = join(root, entry);
  return {path, bytes: statSync(path).isDirectory() ? treeBytes(path) : statSync(path).size};
});
const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`语音记录目录：${root}`);
console.log(`将删除 ${entries.length} 项，共 ${(total / 1024 / 1024).toFixed(1)} MB：`);
for (const entry of entries) console.log(`  ${entry.path}（${(entry.bytes / 1024 / 1024).toFixed(1)} MB）`);
if (dryRun) {
  console.log("--dry-run：未删除任何内容。");
  process.exit(0);
}
for (const entry of entries) {
  rmSync(entry.path, {recursive: true, force: true});
  console.log(`  已删除 ${entry.path}`);
}
console.log(`已清空 ${entries.length} 项；目录保留：${root}`);
