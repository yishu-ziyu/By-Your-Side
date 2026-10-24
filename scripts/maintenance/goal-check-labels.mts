/**
 * 核对标注集：从诊断记录里收集核对输入（goal_check_input）和当时判的结论，生成一页本机可改的标注表，给 goal-check-bench.mts 当尺子。
 *
 *   npx tsx scripts/maintenance/goal-check-labels.mts collect [--from=目录或.jsonl,…]   默认：最新一份 npm run logs 导出，加 out/self-use 下各次回放
 *   npx tsx scripts/maintenance/goal-check-labels.mts show <编号>…                      终端里看几条的摘要（网址、标题换成占位）
 *   npx tsx scripts/maintenance/goal-check-labels.mts set <编号> <结论> <理由> [标签,…]  填一条标注
 *   npx tsx scripts/maintenance/goal-check-labels.mts page                              生成 labels.html：本机打开，改完点「导出」
 *   npx tsx scripts/maintenance/goal-check-labels.mts merge <导出的.json>                把页面里改过的标注并回 labels.json
 *
 * 标注集只放在 out/goal-check-labels/，不进仓库。日常记录没脱敏：终端只打印编号、结论和去掉网址、标题的文字，网页原文只进本机那一页。
 * 收两种记录：完整核对事件（goal_check 带 replayInput，限 checkGoal 自己判的），和更早的 goal_check_input 配下一条结论。
 * 其余还原不了，不收，只报条数。
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REPO } from "../acceptance/real-path/harness.mts";

/** 标注集和日常导出都在主目录的 out/ 下：工作树合并后会删掉，标注不能跟着丢。 */
export const MAIN = dirname(resolve(REPO, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).trim()));

type Status = "done" | "continue" | "needs_user" | "open" | "blocked";
type Entry = { id: string; source: string; at: string; input: Record<string, unknown>; recorded: string | null; expected: Status | null; reason: string; tags: string[] };

const DIR = join(MAIN, "out/goal-check-labels");
const FILE = join(DIR, "labels.json");
const STATUSES: readonly Status[] = ["done", "continue", "needs_user", "open", "blocked"];
const [command, ...rest] = process.argv.slice(2);

function load(): Entry[] {
  if (!existsSync(FILE)) return [];
  const value: unknown = JSON.parse(readFileSync(FILE, "utf8"));

  return Array.isArray(value) ? value.filter((item): item is Entry => !!item && typeof item === "object" && typeof (item as Entry).id === "string" && !!(item as Entry).input) : [];
}

const save = async (entries: Entry[]) => { await mkdir(DIR, { recursive: true }); await writeFile(FILE, JSON.stringify(entries, null, 1)); };

/**
 * 尺子把 replayInput 交给 checkGoal 重判，只有 checkGoal 里面的判定能这样还原。
 * 会话层的宿主判定（复核没重读、证据没变、取消、核对前的规则、事后改判）重跑 checkGoal 会得出别的结论，不进标注集。
 */
const REPLAYABLE = new Set(["model", "host:copies", "host:csv_escaped_newlines", "host:csv_total_mismatch", "host:dead_clicks", "host:no_captions", "host:single_search_wording"]);

/** 一份诊断记录里能重放的核对，和不能重放的核对条数。 */
function checksIn(file: string, source: string): { found: Entry[]; unreplayable: number } {
  const found: Entry[] = [];
  let unreplayable = 0;
  const pending = new Map<string, Entry>();

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"goal_check')) continue;
    let record: { type?: unknown; runId?: unknown; sessionId?: unknown; time?: unknown; data?: Record<string, unknown> };
    try { record = JSON.parse(line); } catch { continue; }
    const run = String(record.runId ?? record.sessionId ?? "");

    if (record.type === "goal_check_input" && record.data) {
      const id = createHash("sha256").update(`${record.sessionId}${record.time}`).digest("hex").slice(0, 8);
      const entry: Entry = { id, source, at: String(record.time ?? ""), input: record.data, recorded: null, expected: null, reason: "", tags: [] };
      found.push(entry);
      pending.set(run, entry);
    } else if (record.type === "goal_check") {
      const data = record.data;
      const replayInput = data?.replayInput;

      if (data?.v === 1 && typeof data.checkId === "string" && REPLAYABLE.has(String(data.decidedBy)) && replayInput && typeof replayInput === "object" && !Array.isArray(replayInput)) {
        found.push({ id: data.checkId.slice(0, 8), source, at: String(record.time ?? ""), input: replayInput as Record<string, unknown>, recorded: typeof data.status === "string" ? data.status : null, expected: null, reason: "", tags: [] });
      } else if (pending.has(run)) {
        pending.get(run)!.recorded = typeof data?.status === "string" ? data.status : null;
        pending.delete(run);
      } else unreplayable += 1;
    }
  }

  return { found, unreplayable };
}

function sources(): Array<{ file: string; source: string }> {
  const from = rest.find(a => a.startsWith("--from="))?.slice(7).split(",").map(p => resolve(p));
  const files = (path: string): string[] => statSync(path).isDirectory() ? readdirSync(path).flatMap(name => files(join(path, name))) : path.endsWith(".jsonl") ? [path] : [];

  const named = (file: string) => file.endsWith(".trace.jsonl") ? `replay:${basename(dirname(file))}/${basename(file, ".trace.jsonl")}` : file.includes("/daily-logs/") ? "daily" : basename(file);

  if (from) return from.flatMap(files).map(file => ({ file, source: named(file) }));
  const logs = join(MAIN, "out/daily-logs");
  const latest = existsSync(logs) ? readdirSync(logs).filter(name => existsSync(join(logs, name, "traces.jsonl"))).sort().at(-1) : undefined;
  const replays = join(MAIN, "out/self-use");
  const local = join(homedir(), ".sideagent/traces");

  return [
    ...(existsSync(local) ? readdirSync(local).filter(name => name.endsWith(".jsonl")).map(name => ({ file: join(local, name), source: "local" })) : []),
    ...(latest ? [{ file: join(logs, latest, "traces.jsonl"), source: "daily" }] : []),
    ...(existsSync(replays) ? files(replays).filter(file => file.endsWith(".trace.jsonl")).map(file => ({ file, source: named(file) })) : []),
  ];
}

const hideUrls = (text: string) => text.replace(/https?:\/\/[^\s"'<>)\]）」]+/g, "«网址»");

/** 终端里看的摘要：不带网址、标题和网页正文，只够判该判什么。 */
function brief(entry: Entry): string {
  const input = entry.input as { goal?: string[]; lastReply?: string; facts?: { actions?: Array<{ tools: string[]; onGoalPage: boolean; openedByAssistant: boolean; page: string | null }>; typedNotFromUser?: string[]; searchedNotFromUser?: string[] }; observations?: Array<{ tool: string; text: string; earlier?: boolean }>; files?: unknown[]; replyCards?: unknown[]; page?: { text?: string } | null };
  const daily = entry.source === "daily" || entry.source === "local";
  const facts = input.facts;

  return [
    `── ${entry.id}  ${entry.source}  当时判 ${entry.recorded ?? "?"}${entry.expected ? `  标注 ${entry.expected}（${entry.reason}）` : ""}`,
    `原话：${hideUrls((input.goal ?? []).join(" / ")).slice(0, 300)}`,
    `回答：${hideUrls(input.lastReply ?? "").replace(/\s+/g, " ").slice(0, 700)}`,
    `事实：动作 ${(facts?.actions ?? []).map(a => `${a.tools.join("+")}@${a.onGoalPage ? "用户那页" : a.openedByAssistant ? "助手打开的页" : a.page ? "点过去的页" : "没读到地址"}`).join("，") || "无"}；自己输入 ${daily ? `${facts?.typedNotFromUser?.length ?? 0} 条` : JSON.stringify(facts?.typedNotFromUser ?? [])}；搜索 ${daily ? `${facts?.searchedNotFromUser?.length ?? 0} 条` : JSON.stringify(facts?.searchedNotFromUser ?? [])}`,
    `读数：${(input.observations ?? []).map(o => `${o.tool}${o.earlier ? "(早)" : ""} ${o.text.length}字`).join("，")}；当前页 ${input.page?.text?.length ?? 0} 字；文件 ${input.files?.length ?? 0}；卡片 ${input.replyCards?.length ?? 0}`,
  ].join("\n");
}

const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 本机打开的标注页：只改不同意的，改完点「导出」存成 json，再 merge 回来。 */
function page(entries: Entry[]): string {
  const rows = entries.map(entry => {
    const input = entry.input as { goal?: string[]; lastReply?: string; goalPage?: { url?: string } | null; facts?: { actions?: Array<{ tools: string[]; onGoalPage: boolean; openedByAssistant: boolean; page: string | null }>; searchedNotFromUser?: string[] } };
    const facts = (input.facts?.actions ?? []).map(a => `${a.tools.join("+")} @ ${a.onGoalPage ? "用户那页" : a.openedByAssistant ? "助手打开的页" : "点过去的页"}${a.page ? `（${a.page}）` : ""}`).concat((input.facts?.searchedNotFromUser ?? []).map(t => `搜了「${t}」`)).join("<br>") || "—";
    const options = STATUSES.map(s => `<option${entry.expected === s ? " selected" : ""}>${s}</option>`).join("");

    return `<tr data-id="${entry.id}" data-recorded="${entry.recorded ?? ""}"><td class="id">${entry.id}<div class="src">${escape(entry.source)}</div></td><td>${escape((input.goal ?? []).join(" / "))}<div class="src">${escape(input.goalPage?.url ?? "")}</div></td><td class="reply">${escape((input.lastReply ?? "").slice(0, 600))}</td><td class="facts">${facts}</td><td class="rec">${entry.recorded ?? "?"}</td><td><select>${options}</select></td><td><textarea rows="3">${escape(entry.reason)}</textarea></td></tr>`;
  }).join("\n");

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>核对标注</title><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#0969da;--diff:#fff8c5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--diff:#3b2e0a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}h1{font-size:18px;margin:0}
.muted,.src{color:var(--muted);font-size:12px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top;text-align:left}
th{position:sticky;top:0;background:var(--bg)}.reply{max-width:420px;white-space:pre-wrap}.facts{max-width:260px;font-size:12px}.id{font-family:ui-monospace,monospace}
tr.changed{background:var(--diff)}textarea{width:220px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
select,button{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}button{border-color:var(--accent);color:var(--accent);cursor:pointer}
</style></head><body><header><h1>核对标注 · ${entries.length} 条</h1><span class="muted">「该判」和「理由」是代理先填的；只改不同意的。黄底：该判和当时判的不一样。改完点导出，把文件交回来。</span><label class="muted"><input type="checkbox" id="only"> 只看黄底</label><button id="export">导出</button></header>
<table><thead><tr><th>编号</th><th>原话</th><th>回答开头</th><th>宿主事实</th><th>当时判</th><th>该判</th><th>理由</th></tr></thead><tbody>
${rows}
</tbody></table><script>
const rows=[...document.querySelectorAll("tbody tr")];
const mark=r=>r.classList.toggle("changed",r.querySelector("select").value!==r.dataset.recorded);
rows.forEach(r=>{mark(r);r.querySelector("select").addEventListener("change",()=>mark(r));});
document.getElementById("only").addEventListener("change",e=>rows.forEach(r=>r.hidden=e.target.checked&&!r.classList.contains("changed")));
document.getElementById("export").addEventListener("click",()=>{const data=rows.map(r=>({id:r.dataset.id,expected:r.querySelector("select").value,reason:r.querySelector("textarea").value}));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,1)],{type:"application/json"}));a.download="goal-check-labels-edited.json";a.click();});
</script></body></html>`;
}

const entries = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) ? load() : null;

if (!entries) {
  // 被 goal-check-bench.mts 当模块引用时只给 MAIN，不跑命令。
} else if (command === "collect") {
  const known = new Map(entries.map(entry => [entry.id, entry]));
  let added = 0;
  let unreplayable = 0;

  for (const { file, source } of sources()) {
    const checks = checksIn(file, source);
    unreplayable += checks.unreplayable;

    for (const entry of checks.found) {
      if (known.has(entry.id)) continue;
      known.set(entry.id, entry);
      added += 1;
    }
  }

  const all = [...known.values()];
  await save(all);
  const tally = (pick: (e: Entry) => string | null) => Object.entries(all.reduce<Record<string, number>>((count, e) => ({ ...count, [pick(e) ?? "无"]: (count[pick(e) ?? "无"] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join("、");
  console.log(`新收 ${added} 条，共 ${all.length} 条（${FILE}）。\n来源：${tally(e => e.source.split(":")[0]!)}\n当时判：${tally(e => e.recorded)}\n已标注：${all.filter(e => e.expected).length}\n不能重放（旧记录没存核对输入，或是核对之外的宿主判定）：${unreplayable} 条`);
} else if (command === "show") {
  for (const id of rest) { const entry = entries.find(e => e.id === id); console.log(entry ? brief(entry) : `没有 ${id}`); }
  if (!rest.length) for (const entry of entries) console.log(brief(entry));
} else if (command === "set") {
  const [id, expected, reason, tags] = rest;
  const entry = entries.find(e => e.id === id);

  if (!entry || !STATUSES.includes(expected as Status) || !reason) throw new Error("用法：set <编号> <done|continue|needs_user|open|blocked> <理由> [标签,…]");
  Object.assign(entry, { expected, reason, tags: tags ? tags.split(",") : entry.tags });
  await save(entries);
  console.log(`${id} → ${expected}`);
} else if (command === "page") {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, "labels.html"), page(entries));
  console.log(join(DIR, "labels.html"));
} else if (command === "merge") {
  const edited: unknown = JSON.parse(readFileSync(resolve(rest[0] ?? ""), "utf8"));
  let changed = 0;

  for (const item of Array.isArray(edited) ? edited : []) {
    const entry = entries.find(e => e.id === item?.id);

    if (!entry || !STATUSES.includes(item.expected) || (entry.expected === item.expected && entry.reason === item.reason)) continue;
    entry.expected = item.expected;
    entry.reason = String(item.reason ?? "");
    changed += 1;
  }

  await save(entries);
  console.log(`并回 ${changed} 条改动`);
} else {
  console.error("用法见文件开头：collect | show | set | page | merge");
  process.exit(1);
}
