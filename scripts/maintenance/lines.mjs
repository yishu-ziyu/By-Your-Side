/**
 * 列出所有工作线：每个工作树的分支、未提交改动、比 origin/main 领先和落后几个提交、PR 状态，以及能不能删。
 *
 *   npm run lines
 *   npm run lines -- --stuck   只列停了一天以上、等人处理的工作线，写进 out/heartbeat/latest.md 并发系统通知；每天 9 点由 launchd 跑（scripts/maintenance/heartbeat.plist）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const DAY = 86_400_000;
const days = (ms) => Math.floor((Date.now() - ms) / DAY);

const rows = trees.map(({ path, branch }) => {
  const changed = (run("git", ["status", "--porcelain"], path) ?? "").split("\n").filter(Boolean);
  const dirty = changed.length;
  // 未提交的改动也算动过：只看提交时间会把正在改的工作线当成停了。
  const touched = Math.max(Number(run("git", ["log", "-1", "--format=%ct"], path) ?? 0) * 1000, ...changed.map((line) => {
    try { return statSync(join(path, line.slice(3).replace(/\/$/, ""))).mtimeMs; } catch { return 0; }
  }));
  const [behind, ahead] = (run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"], path) ?? "? ?").split(/\s+/);
  const age = run("git", ["log", "-1", "--format=%cr"], path) ?? "";
  const pr = prs.find((item) => item.headRefName === branch);
  const isMain = path === main;
  let verdict = "进行中";
  if (isMain) verdict = Number(behind) > 0 ? `主目录落后 ${behind} 个提交，可 git pull` : "主目录，已是最新";
  else if (pr?.state === "MERGED" && dirty === 0) verdict = "已合并，可删";
  else if (pr?.state === "MERGED") verdict = "已合并，但有未提交改动，先看";
  else if (!pr && Number(ahead) === 0 && dirty === 0) verdict = "空的，可删";
  return { 目录: path.replace(`${dirname(main)}/`, ""), 分支: branch, 未提交: dirty, 领先: ahead, 落后: behind, 最后提交: age, PR: pr ? `#${pr.number} ${pr.state}` : "", 判断: verdict, isMain, touched };
});

const open = prs.filter((item) => item.state === "OPEN" && !trees.some((tree) => tree.branch === item.headRefName));

if (process.argv.includes("--stuck")) {
  const stuck = [
    ...rows.filter((row) => !row.isMain && (row.判断.includes("可删") || row.判断.includes("先看") || Date.now() - row.touched > DAY))
      .map((row) => `- ${row.分支}${row.PR ? `（${row.PR.split(" ")[0]}）` : ""}：${row.判断.includes("可删") || row.判断.includes("先看") ? row.判断 : `${days(row.touched)} 天没动，${row.未提交} 个未提交文件，落后主干 ${row.落后}`}`),
    ...open.map((item) => `- #${item.number} ${item.headRefName}：PR 开着，本机没有工作树`),
  ];
  const out = join(main, "out/heartbeat");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "latest.md"), `# 工作线检查 ${new Date().toLocaleDateString("sv")}\n\n${stuck.length ? stuck.join("\n") : "没有停住的工作线。"}\n`);
  console.log(stuck.length ? stuck.join("\n") : "没有停住的工作线。");
  if (stuck.length) run("osascript", ["-e", `display notification ${JSON.stringify(stuck.map((line) => line.slice(2)).join("；").slice(0, 200))} with title ${JSON.stringify(`${stuck.length} 条工作线等处理`)}`], main);
} else {
  console.table(rows.map(({ isMain, touched, ...row }) => row));
  if (open.length) console.log(`没有本机工作树的未合并 PR：${open.map((item) => `#${item.number} ${item.headRefName}`).join("、")}`);
}
