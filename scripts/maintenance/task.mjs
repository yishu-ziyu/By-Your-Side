/**
 * 开一个任务工作树：从最新 origin/main 建分支和 ../bys-<名>，并把依赖接好（不用再 npm ci）。
 *
 *   npm run task -- fix/slow-reply      # 分支 fix/slow-reply，目录 ../bys-slow-reply
 *
 * 依赖按 docs/development/checks.md#依赖 建：其他包逐个链回主目录，@sideagent/* 链到工作树自己的源码，
 * 因为整个 node_modules 指回主目录时，扩展构建会悄悄用上主目录的旧代码。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const branch = process.argv[2];
if (!branch || branch.startsWith("-")) {
  console.error("用法：npm run task -- <分支名>，例如 npm run task -- fix/slow-reply");
  process.exit(1);
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const main = dirname(resolve(here, git(["rev-parse", "--git-common-dir"], here)));
const dir = join(dirname(main), `bys-${basename(branch)}`);

if (existsSync(dir)) {
  console.error(`${dir} 已存在。先用 npm run lines 看它是谁的、能不能删。`);
  process.exit(1);
}

git(["fetch", "-q", "origin", "main"], main);
git(["worktree", "add", "-q", "-b", branch, dir, "origin/main"], main);

const from = join(main, "node_modules");
const to = join(dir, "node_modules");
mkdirSync(to);
for (const name of readdirSync(from)) {
  if (name === "@sideagent" || name === "node_modules") continue;
  symlinkSync(join(from, name), join(to, name));
}
mkdirSync(join(to, "@sideagent"));
for (const pkg of ["agent", "extension"]) symlinkSync(`../../${pkg}`, join(to, "@sideagent", pkg));

console.log(`工作树：${dir}\n分支：${branch}（从 origin/main 新建）\n依赖已接好。合并后在主目录运行：git worktree remove ${dir}`);
