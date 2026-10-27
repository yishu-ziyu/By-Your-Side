/**
 * 列出所有工作线：每个工作树的分支、未提交改动、比 origin/main 领先和落后几个提交、PR 状态，以及能不能删。
 *
 *   npm run lines
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const main = dirname(resolve(here, run("git", ["rev-parse", "--git-common-dir"], here)));
run("git", ["fetch", "-q", "--prune", "origin"], main);

let prs = [];
try {
  prs = JSON.parse(run("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", "number,state,headRefName"], main) ?? "[]");
} catch {}

const trees = run("git", ["worktree", "list", "--porcelain"], main).split("\n\n").filter(Boolean).map((block) => ({
  path: block.match(/^worktree (.*)$/m)?.[1],
  branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1] ?? "(detached)",
}));

const rows = trees.map(({ path, branch }) => {
  const dirty = (run("git", ["status", "--porcelain"], path) ?? "").split("\n").filter(Boolean).length;
  const [behind, ahead] = (run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"], path) ?? "? ?").split(/\s+/);
  const age = run("git", ["log", "-1", "--format=%cr"], path) ?? "";
  const pr = prs.find((item) => item.headRefName === branch);
  const isMain = path === main;
  let verdict = "进行中";
  if (isMain) verdict = Number(behind) > 0 ? `主目录落后 ${behind} 个提交，可 git pull` : "主目录，已是最新";
  else if (pr?.state === "MERGED" && dirty === 0) verdict = "已合并，可删";
  else if (pr?.state === "MERGED") verdict = "已合并，但有未提交改动，先看";
  else if (!pr && Number(ahead) === 0 && dirty === 0) verdict = "空的，可删";
  return { 目录: path.replace(`${dirname(main)}/`, ""), 分支: branch, 未提交: dirty, 领先: ahead, 落后: behind, 最后提交: age, PR: pr ? `#${pr.number} ${pr.state}` : "", 判断: verdict };
});

console.table(rows);
const open = prs.filter((item) => item.state === "OPEN" && !trees.some((tree) => tree.branch === item.headRefName));
if (open.length) console.log(`没有本机工作树的未合并 PR：${open.map((item) => `#${item.number} ${item.headRefName}`).join("、")}`);
