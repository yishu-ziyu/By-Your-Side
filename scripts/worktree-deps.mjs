#!/usr/bin/env node
/**
 * 给 git 工作树接上依赖，且让 @sideagent/* 指向工作树自己的源码。
 *   node scripts/worktree-deps.mjs <工作树路径>
 * 整个链接主仓库的 node_modules 时，@sideagent/agent 指回主仓库 agent/，工作树里改的 agent/、shared/ 打不进扩展
 * （docs/knowledge/patterns/worktree-workspace-link-builds-main-tree.md）。这里建真目录，其余条目逐个链到主仓库。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const main = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tree = resolve(process.argv[2] ?? "");

if (!process.argv[2] || !existsSync(join(tree, "package.json")) || tree === main) {
  console.error("用法：node scripts/worktree-deps.mjs <工作树路径>（不能是主仓库本身）");
  process.exit(1);
}

const target = join(tree, "node_modules");

// 旧的整体链接先拿掉；已有真目录就重建，保证 @sideagent 指向正确。
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "@sideagent"), { recursive: true });

for (const name of readdirSync(join(main, "node_modules"))) {
  if (name !== "@sideagent") symlinkSync(join(main, "node_modules", name), join(target, name));
}

for (const name of readdirSync(join(main, "node_modules", "@sideagent"))) symlinkSync(join(tree, name), join(target, "@sideagent", name));

console.log(`已接上依赖：${target}；@sideagent/* → ${tree}`);
