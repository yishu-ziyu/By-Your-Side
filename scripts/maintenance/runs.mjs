/**
 * 真实路径用例的运行汇总：今天（或 --days=N 天内）每个用例跑了几次、过了几次、被拦了几次、花了多久。
 * 数据来自 scripts/acceptance/runs-ledger.mjs 记在主目录的 out/acceptance/real-path/runs.jsonl。
 *
 *   npm run runs
 *   npm run runs -- --days=7
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
const ledger = join(dirname(resolve(common)), "out/acceptance/real-path/runs.jsonl");
const days = Number(process.argv.find((arg) => arg.startsWith("--days="))?.slice(7)) || 1;
const since = new Date();
since.setHours(0, 0, 0, 0);
since.setDate(since.getDate() - (days - 1));

const rows = existsSync(ledger)
  ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => new Date(row.at) >= since)
  : [];

if (!rows.length) {
  console.log(`${days === 1 ? "今天" : `${days} 天内`}没有运行记录（${ledger}）。`);
  process.exit(0);
}

const byCase = new Map();
for (const row of rows) {
  const key = [row.case, ...row.args].join(" ");
  const item = byCase.get(key) ?? { 用例: key, 运行: 0, 通过: 0, 失败: 0, 被拦: 0, 分钟: 0 };
  item.运行 += 1;
  if (row.blocked) item.被拦 += 1;
  else if (row.ok) item.通过 += 1;
  else item.失败 += 1;
  item.分钟 += row.seconds / 60;
  byCase.set(key, item);
}

const table = [...byCase.values()].sort((a, b) => b.运行 - a.运行).map((item) => ({ ...item, 分钟: Math.round(item.分钟) }));
const judged = rows.filter((row) => !row.blocked);
const passed = judged.filter((row) => row.ok).length;
const minutes = Math.round(rows.reduce((sum, row) => sum + row.seconds, 0) / 60);

console.table(table);
console.log(`${days === 1 ? "今天" : `${days} 天内`}：运行 ${rows.length} 次，通过 ${passed}/${judged.length}（${judged.length ? Math.round((passed / judged.length) * 100) : 0}%），被拦 ${rows.length - judged.length} 次，累计 ${minutes} 分钟。`);
