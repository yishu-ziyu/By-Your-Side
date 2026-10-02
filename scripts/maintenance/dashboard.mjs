#!/usr/bin/env node
/**
 * 项目看板：从仓库现有数据（git、gh、评测结果、STATUS）生成一页静态 HTML。
 * 输出 out/dashboard/index.html；只读，不改仓库、不联网同步，gh 不可用时对应区块降级。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const OUT_DIR = join(ROOT, "out", "dashboard");

const RECENT_DAYS = 3;

const SMALL_N = 10;

const CATEGORY_LABELS = {
  page_understanding: "读懂网页",
  selection_ask: "划词提问",
  browser_action_single: "单步操作",
  other: "其他",
  browser_action_multistep: "多步操作",
  extraction_to_table: "提取成表格",
  form_fill_no_submit: "填表（不提交）",
  cross_tab: "跨标签",
  memory_skill: "记忆与技能",
  research_multi_page: "多页调研",
  translation: "翻译",
};

const TYPE_LABELS = {
  feat: "新功能",
  fix: "修复",
  docs: "文档",
  merge: "合并",
  refactor: "整理代码",
  test: "测试",
  chore: "杂项",
  perf: "提速",
  ci: "自动检查",
  other: "其他",
};

// ---------- helpers ----------

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function run(cmd, args, timeout = 20_000) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// gh 偶尔遇到瞬时网络错误（如 graphql EOF），多试一次再降级。
function tryRun(cmd, args, timeout) {
  const attempts = cmd === "gh" ? 2 : 1;
  let last;

  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, out: run(cmd, args, timeout) };
    } catch (error) {
      last = String(error.stderr || error.message || error).trim().split("\n")[0];
    }
  }

  return { ok: false, error: last };
}

function readText(rel) {
  const full = join(ROOT, rel);

  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function readJson(rel) {
  const text = readText(rel);

  return text == null ? null : JSON.parse(text);
}

function fmtTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");

  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDay(date) {
  const d = new Date(date);
  const week = "日一二三四五六"[d.getDay()];

  return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
}

function pct(rate) {
  return `${Math.round(rate * 100)}%`;
}

function shortModel(spec) {
  return spec
    .split("+")
    .map((part) => part.split("/").pop())
    .join(" + 快速 ");
}

// Relative link from out/dashboard/index.html back into the repo.
function repoHref(rel) {
  return `../../${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function notice(text) {
  return `<p class="notice">${esc(text)}</p>`;
}

// Minimal RFC 4180 CSV parser (quoted fields may contain commas, quotes, newlines).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell !== ""));

  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------- section 1: top line ----------

function topLine() {
  const parts = [`<span>生成于 ${esc(fmtTime(Date.now()))}</span>`];
  const head = tryRun("git", ["rev-parse", "--short", "main"]);

  if (head.ok) parts.push(`<span>main 最新提交 <b class="mono">${esc(head.out.trim())}</b></span>`);
  else parts.push(`<span class="muted">读不到 main 提交</span>`);

  const counts = tryRun("git", ["rev-list", "--left-right", "--count", "main...origin/main"]);

  if (counts.ok) {
    const [ahead, behind] = counts.out.trim().split(/\s+/).map(Number);
    let sync = "本地与远端一致";

    if (ahead && behind) sync = `本地多 ${ahead} 个提交未推送，远端多 ${behind} 个未拉取`;
    else if (ahead) sync = `本地多 ${ahead} 个提交未推送`;
    else if (behind) sync = `远端多 ${behind} 个提交未拉取`;

    parts.push(`<span>${esc(sync)}<small class="muted">（按本机上次同步的远端记录）</small></span>`);
  } else parts.push(`<span class="muted">读不到远端 main</span>`);

  const status = readText("docs/STATUS.md");
  const match = status?.match(/日常 Chrome 已于\s*(\S+?)\s*重载到 main\s*`([0-9a-f]+)`/);

  if (match) {
    const behindDaily = tryRun("git", ["rev-list", "--count", `${match[2]}..main`]);
    const lag = behindDaily.ok && Number(behindDaily.out.trim()) > 0 ? `，之后 main 又有 ${behindDaily.out.trim()} 个提交` : "";

    parts.push(`<span>日常扩展装的是 <b class="mono">${esc(match[2])}</b>（${esc(match[1])} 重载${esc(lag)}）</span>`);
  } else parts.push(`<span class="muted">进度页里没找到日常扩展的版本记录</span>`);

  return `<div class="topline">${parts.join("")}</div>`;
}

// ---------- section 2: tiers ----------

function loadTasks() {
  const text = readText("eval/tasks/tasks.jsonl");

  if (!text) return [];

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function tierRate(rows, categories) {
  const inTier = rows.filter((r) => categories.includes(r.category));
  const passed = inTier.filter((r) => r.pass).length;

  return { n: inTier.length, rate: inTier.length ? passed / inTier.length : null };
}

function loadSeries() {
  const series = [];
  const baselineCsv = readText("eval/results/full-1/report_per_task.csv");

  if (baselineCsv) {
    const rows = parseCsv(baselineCsv).filter((r) => !r.model.includes("nothink") && (r.pass === "True" || r.pass === "False"));
    const models = [...new Set(rows.map((r) => r.model))].sort();

    for (const model of models) {
      series.push({
        group: "9 月底基线（旧模型、修复前）",
        label: shortModel(model),
        baseline: true,
        rows: rows.filter((r) => r.model === model).map((r) => ({ task: r.task, category: r.category, pass: r.pass === "True" })),
      });
    }
  }

  const setupNotApplied = new Set();
  const runsDir = join(ROOT, "eval", "runs");
  const runIds = existsSync(runsDir) ? readdirSync(runsDir).sort() : [];

  for (const runId of runIds) {
    let report;

    try {
      report = readJson(`eval/runs/${runId}/report.json`);
    } catch {
      continue;
    }

    if (!report || !Array.isArray(report.per_task)) continue;

    for (const id of report.setup_not_applied_task_ids ?? []) setupNotApplied.add(id);

    const judged = report.per_task.filter((r) => ["pass", "fail", "undeterminable"].includes(r.verdict));
    const models = [...new Set(report.per_task.map((r) => r.model))].sort();

    for (const model of models) {
      series.push({
        group: `新评测：${runId}`,
        label: shortModel(model),
        baseline: false,
        environmentRows: report.per_task.filter(r => r.model === model && r.verdict === "environment"),
        rows: judged.filter((r) => r.model === model).map((r) => ({ task: r.task, category: r.category, pass: r.pass_ === true })),
      });
    }
  }

  return { series, setupNotApplied, hasBaseline: Boolean(baselineCsv) };
}

function tierChart(series, tier) {
  const W = 860;
  const LABEL_W = 250;
  const BAR_W = 300;
  const GROUP_H = 30;
  const items = [];
  let y = 8;
  let lastGroup = null;

  for (const s of series) {
    const { n, rate } = tierRate(s.rows, tier.categories);

    const environment = (s.environmentRows ?? []).filter(r=>tier.categories.includes(r.category)).length;

    if (!n && !environment) continue;

    if (!n) {
      items.push(`<text x="0" y="${y + 19}" class="s">${esc(s.label)}：${environment}条站点不可用，没有可计算的通过率</text>`);
      y += 32;
      continue;
    }

    if (s.group !== lastGroup) {
      items.push(`<text x="0" y="${y + 18}" class="g">${esc(s.group)}</text>`);
      y += GROUP_H;
      lastGroup = s.group;
    }

    // 「主模型 + 快速 模型」分两行，长名字不压到条形上。
    const [main, fast] = s.label.split(" + 快速 ");
    let note = `${n} 题${environment ? ` · 另有${environment}条站点不可用` : ""}`;

    if (tier.target != null) {
      const gap = Math.round((tier.target - rate) * 100);

      note += gap > 0 ? ` · 差 ${gap} 个百分点` : " · 已达标";
    }

    const small = n < SMALL_N ? `只有 ${n} 题，仅供参考` : "";
    const rowH = fast || small ? 46 : 32;
    const valueX = LABEL_W + BAR_W + 14;

    items.push(
      `<text x="0" y="${y + 19}" class="l">${esc(main)}</text>` +
        (fast ? `<text x="0" y="${y + 37}" class="s">快速模型 ${esc(fast)}</text>` : "") +
        `<rect x="${LABEL_W}" y="${y + 6}" width="${BAR_W}" height="16" rx="3" class="track"/>` +
        `<rect x="${LABEL_W}" y="${y + 6}" width="${Math.max(rate * BAR_W, 2).toFixed(1)}" height="16" rx="3" class="${s.baseline ? "bar old" : "bar"}"/>` +
        `<text x="${valueX}" y="${y + 19}" class="v"><tspan class="vb">${pct(rate)}</tspan>  ${esc(note)}</text>` +
        (small ? `<text x="${valueX}" y="${y + 37}" class="s">${esc(small)}</text>` : ""),
    );
    y += rowH;
  }

  if (!items.length) return notice("这一档还没有评过分的结果。");

  let target = "";

  if (tier.target != null) {
    const x = LABEL_W + tier.target * BAR_W;

    target = `<line x1="${x}" y1="4" x2="${x}" y2="${y + 2}" class="target"/><text x="${x}" y="${y + 18}" class="t" text-anchor="middle">目标 ${pct(tier.target)}</text>`;
    y += 22;
  }

  return `<svg viewBox="0 0 ${W} ${y + 4}" width="100%" role="img" aria-label="${esc(tier.name)}各模型通过率">${items.join("")}${target}</svg>`;
}

function tiersSection() {
  const tiersDoc = readJson("eval/tasks/tiers.json");

  if (!tiersDoc?.tiers) return notice("没找到能力分档表，这一块暂时空着。");

  const { series, setupNotApplied, hasBaseline } = loadSeries();
  const tasks = loadTasks();

  for (const t of tasks) if (t.setup) setupNotApplied.add(t.id);

  const head = [];

  if (!hasBaseline) head.push(notice("没找到 9 月底基线结果。"));

  if (!series.some((s) => !s.baseline)) head.push(notice("还没有新的评测运行出过判分结果。"));

  const cards = Object.entries(tiersDoc.tiers).map(([key, tier]) => {
    const cats = tier.categories.map((c) => CATEGORY_LABELS[c] ?? c).join("、");
    const goal = tier.target != null ? `目标通过率 ${pct(tier.target)}` : "不设通过率目标，陪着用户一起做";
    const unfaithful = tasks.filter((t) => tier.categories.includes(t.category) && setupNotApplied.has(t.id));
    let caveat = "";

    if (unfaithful.length) {
      const kinds = [...new Set(unfaithful.map((t) => CATEGORY_LABELS[t.category] ?? t.category))].join("、");

      caveat = `<p class="caveat">本档有 ${unfaithful.length} 题（${esc(kinds)}）需要评测先做一步准备（如选中一段文字、先开好另一个标签页），这一步评测时没执行，这些题的结果不能代表真实表现。</p>`;
    }

    return `<div class="card tier">
  <div class="tier-head"><h3>第 ${esc(key)} 档 · ${esc(tier.name)}</h3><span class="goal">${esc(goal)}</span></div>
  <p class="muted small">包含：${esc(cats)}</p>
  ${tierChart(series, tier)}
  ${caveat}
</div>`;
  });

  return head.join("") + cards.join("\n") + `<p class="evidence">来源：eval/tasks/tiers.json · eval/results/full-1/report_per_task.csv（不含关闭思考的对照组）· eval/runs/*/report.json；浅色条为旧基线。</p>`;
}

// ---------- section 3: recent commits ----------

function evalOutcome(rel) {
  const text = readText(rel);

  if (!text) return null;

  const title = text.match(/^#\s*任务\s*[:：]\s*(.+)$/m)?.[1] ?? text.match(/^#\s+(.+)$/m)?.[1] ?? rel;
  const done = (text.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const open = (text.match(/^\s*- \[ \]/gm) ?? []).length;

  return { title: title.trim(), done, total: done + open, rel };
}

function commitType(subject) {
  if (/^merge\b/i.test(subject)) return "merge";

  const m = subject.match(/^(\w+)(\([^)]*\))?!?:/);

  return m && TYPE_LABELS[m[1].toLowerCase()] ? m[1].toLowerCase() : "other";
}

function commitsSection() {
  const log = tryRun("git", ["log", "main", `--since=${RECENT_DAYS} days ago`, "--format=%h%x1f%cI%x1f%s%x1f%b%x1e"]);

  if (!log.ok) return notice(`读不到提交记录：${log.error}`);

  const commits = log.out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [hash, date, subject, body = ""] = rec.split("\x1f");
      const docs = [...new Set([...body.matchAll(/Acceptance:\s*(docs\/evals\/\S+?\.md)/g)].map((m) => m[1]))];

      return { hash, date, subject, type: commitType(subject), outcomes: docs.flatMap((doc) => evalOutcome(doc) ?? []) };
    });

  if (!commits.length) return notice(`最近 ${RECENT_DAYS} 天没有新提交。`);

  const counts = {};

  for (const c of commits) counts[c.type] = (counts[c.type] ?? 0) + 1;

  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `<span class="chip ${type}">${esc(TYPE_LABELS[type])} ${n}</span>`)
    .join("");

  let html = `<p class="summary">最近 ${RECENT_DAYS} 天共 ${commits.length} 个提交 ${summary}</p><ol class="timeline">`;
  let lastDay = null;

  for (const c of commits) {
    const day = fmtDay(c.date);

    if (day !== lastDay) {
      html += `<li class="day">${esc(day)}</li>`;
      lastDay = day;
    }

    const outcomes = c.outcomes
      .map(
        (o) =>
          `<div class="outcome"><span class="outcome-label">用户能看到：</span>${esc(o.title)}` +
          (o.total ? ` <span class="ticks">完成标准 ${o.done}/${o.total}</span>` : "") +
          ` <a class="evidence" href="${esc(repoHref(o.rel))}">验收记录</a></div>`,
      )
      .join("");

    html += `<li class="commit"><span class="time">${esc(fmtTime(c.date).split(" ")[1])}</span><div class="body"><div><span class="chip ${c.type}">${esc(TYPE_LABELS[c.type])}</span> ${esc(c.subject)} <span class="evidence mono">${esc(c.hash)}</span></div>${outcomes}</div></li>`;
  }

  return `${html}</ol>`;
}

// ---------- section 4: issues ----------

function parseIssueTitle(title) {
  const m = title.match(/^\[([^\]/]*)\/?(P\d[^\]]*)?\]\s*(.*)$/);

  if (!m) return { kind: null, priority: null, text: title };

  return { kind: m[1] || null, priority: m[2] || null, text: m[3] };
}

function issuesSection() {
  const open = tryRun("gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,labels,createdAt,updatedAt,url"]);

  if (!open.ok) return notice(`暂时连不上 GitHub，问题列表没取到（${open.error}）。`);

  const issues = JSON.parse(open.out).map((i) => ({ ...i, ...parseIssueTitle(i.title) }));
  const groups = new Map();

  for (const issue of issues) {
    const key = issue.priority ?? "未标优先级";

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }

  const order = [...groups.keys()].sort((a, b) => (a.startsWith("P") ? a : "P9").localeCompare(b.startsWith("P") ? b : "P9"));
  let html = issues.length ? `<p class="summary">还开着 ${issues.length} 个问题</p>` : notice("没有还开着的问题。");

  html += `<div class="prio-grid">`;

  for (const key of order) {
    const list = groups
      .get(key)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(
        (i) =>
          `<li>${i.kind ? `<span class="chip kind">${esc(i.kind)}</span>` : ""}${esc(i.text)} <a class="evidence" href="${esc(i.url)}">#${i.number}</a><span class="evidence"> · ${esc(fmtTime(i.updatedAt))} 更新</span></li>`,
      )
      .join("");

    html += `<div class="card prio"><h3>${esc(key === "P1" ? "P1 · 最急" : key)}<span class="count">${groups.get(key).length}</span></h3><ul class="issues">${list}</ul></div>`;
  }

  html += `</div>`;

  const closed = tryRun("gh", ["issue", "list", "--state", "closed", "--limit", "15", "--json", "number,title,closedAt,url"]);

  if (!closed.ok) return html + notice("最近关闭的问题没取到。");

  const since = Date.now() - RECENT_DAYS * 86_400_000;

  const recent = JSON.parse(closed.out)
    .filter((i) => Date.parse(i.closedAt) >= since)
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));

  if (!recent.length) return html + `<p class="muted small">最近 ${RECENT_DAYS} 天没有关闭的问题。</p>`;

  const items = recent
    .map((i) => `<li><span class="check">✓</span>${esc(parseIssueTitle(i.title).text)} <a class="evidence" href="${esc(i.url)}">#${i.number}</a><span class="evidence"> · ${esc(fmtTime(i.closedAt))} 关闭</span></li>`)
    .join("");

  return `${html}<h3 class="sub">最近 ${RECENT_DAYS} 天解决了 ${recent.length} 个</h3><ul class="closed">${items}</ul>`;
}

// ---------- section 5: capabilities ----------

function stripMd(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .trim();
}

function evidenceLinks(cell) {
  const links = [...cell.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)];

  if (!links.length) return "";

  return links
    .map(([, label, href]) => {
      const target = /^[a-z]+:/i.test(href) ? href : repoHref(`docs/${href}`);

      return `<a href="${esc(target)}">${esc(label)}</a>`;
    })
    .join(" · ");
}

function capabilitiesSection() {
  const status = readText("docs/STATUS.md");

  if (!status) return notice("没找到项目进度页，这一块暂时空着。");

  const start = status.indexOf("## 现在能用什么、还差什么");

  if (start < 0) return notice("进度页里没找到「现在能用什么、还差什么」这张表。");

  const after = status.slice(start).split("\n").slice(1);
  const end = after.findIndex((line) => line.startsWith("## "));
  const tableLines = (end < 0 ? after : after.slice(0, end)).filter((line) => line.trim().startsWith("|"));

  const rows = tableLines
    .slice(2)
    .map((line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim()));

  if (!rows.length) return notice("「现在能用什么、还差什么」表是空的。");

  const cards = rows.map(([name = "", now = "", missing = "", evidence = ""]) => {
    const nowText = stripMd(now);
    const shortNow = nowText.length > 80 ? `${nowText.slice(0, 78)}…` : nowText;

    const nowHtml =
      nowText.length > 80
        ? `<details><summary>${esc(shortNow)}<span class="more">展开</span></summary><p>${esc(nowText)}</p></details>`
        : `<p>${esc(nowText)}</p>`;

    const links = evidenceLinks(evidence);

    return `<div class="card cap">
  <h3>${esc(stripMd(name))}</h3>
  <div class="label">现在</div>${nowHtml}
  <div class="missing"><div class="label">还差</div><p>${esc(stripMd(missing)) || "—"}</p></div>
  ${links ? `<p class="evidence">依据：${links}</p>` : ""}
</div>`;
  });

  return `<div class="cap-grid">${cards.join("\n")}</div>`;
}

// ---------- section 6: work lines ----------

function workSection() {
  const blocks = [];
  const refs = tryRun("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(subject)", "refs/heads", "refs/remotes"]);

  if (refs.ok) {
    const all = refs.out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\x1f"))
      .filter(([name]) => name !== "origin/HEAD" && name !== "origin");

    const render = (list) =>
      list.length
        ? `<ul class="plain">${list.map(([name, date, subject]) => `<li><b class="mono">${esc(name)}</b> <span class="muted">${esc(fmtTime(date))}</span><div class="small muted">${esc(subject)}</div></li>`).join("")}</ul>`
        : `<p class="muted small">没有</p>`;

    const local = all.filter(([name]) => !name.startsWith("origin/"));
    const remote = all.filter(([name]) => name.startsWith("origin/"));

    blocks.push(`<div class="card"><h3>本机分支<span class="count">${local.length}</span></h3>${render(local)}</div>`);
    blocks.push(`<div class="card"><h3>GitHub 上的分支<span class="count">${remote.length}</span></h3>${render(remote)}</div>`);
  } else blocks.push(`<div class="card">${notice(`读不到分支：${refs.error}`)}</div>`);

  const wt = tryRun("git", ["worktree", "list", "--porcelain"]);

  if (wt.ok) {
    const trees = wt.out
      .split("\n\n")
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const path = chunk.match(/^worktree (.+)$/m)?.[1] ?? "";
        const branch = chunk.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "（未挂分支）";
        const head = chunk.match(/^HEAD ([0-9a-f]{7})/m)?.[1] ?? "";

        return { name: path.split("/").pop(), branch, head, main: resolve(path) === ROOT };
      });

    const items = trees.map((t) => `<li><b>${esc(t.name)}</b>${t.main ? ' <span class="muted small">（主目录）</span>' : ""} <span class="muted">在 <span class="mono">${esc(t.branch)}</span> · ${esc(t.head)}</span></li>`).join("");

    blocks.push(`<div class="card"><h3>同时开着的工作目录<span class="count">${trees.length}</span></h3><ul class="plain">${items}</ul></div>`);
  } else blocks.push(`<div class="card">${notice(`读不到工作目录：${wt.error}`)}</div>`);

  const prs = tryRun("gh", ["pr", "list", "--state", "open", "--json", "number,title,headRefName,isDraft,updatedAt,url"]);

  if (prs.ok) {
    const list = JSON.parse(prs.out);

    const items = list.length
      ? `<ul class="plain">${list.map((p) => `<li>${p.isDraft ? '<span class="chip other">草稿</span>' : ""}${esc(p.title)} <a class="evidence" href="${esc(p.url)}">#${p.number}</a><div class="small muted">分支 <span class="mono">${esc(p.headRefName)}</span> · ${esc(fmtTime(p.updatedAt))} 更新</div></li>`).join("")}</ul>`
      : `<p class="muted small">没有等待合并的改动</p>`;

    blocks.push(`<div class="card"><h3>等待合并的改动（PR）<span class="count">${list.length}</span></h3>${items}</div>`);
  } else blocks.push(`<div class="card"><h3>等待合并的改动（PR）</h3>${notice(`暂时连不上 GitHub（${prs.error}）`)}</div>`);

  return `<div class="work-grid">${blocks.join("\n")}</div>`;
}

// ---------- page ----------

function safeSection(title, lead, build) {
  let body;

  try {
    body = build();
  } catch (error) {
    body = notice(`这一块生成时出错：${error.message}`);
  }

  return `<section><h2>${esc(title)}</h2>${lead ? `<p class="lead">${esc(lead)}</p>` : ""}${body}</section>`;
}

const CSS = `
:root{--bg:#f7f7f4;--card:#fff;--ink:#1f2328;--muted:#6b7078;--line:#e6e4de;--accent:#2f6f8f;--accent-soft:#e7f0f4;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;}
main{max-width:1080px;margin:0 auto;padding:40px 32px 72px}
h1{font-size:26px;font-weight:600;margin:0 0 6px;letter-spacing:.02em}
h2{font-size:19px;font-weight:600;margin:0 0 4px}
h3{font-size:15px;font-weight:600;margin:0}
section{margin-top:52px}
.lead{color:var(--muted);margin:0 0 18px}
.topline{display:flex;flex-wrap:wrap;gap:6px 28px;align-items:baseline;color:var(--ink);font-size:14px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.muted{color:var(--muted)} .small{font-size:13px}
.notice{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:10px 14px;margin:8px 0}
.evidence,.evidence a{color:#9a9da3;font-size:12px;text-decoration:none}
a.evidence:hover,.evidence a:hover{text-decoration:underline}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.tier{margin-bottom:16px}
.tier-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.goal{color:var(--accent);font-weight:600;font-size:14px}
.tier p.small{margin:2px 0 10px}
svg text{font-family:inherit;font-size:13px;fill:var(--ink)}
svg text.g{font-size:12px;fill:var(--muted)} svg text.s{font-size:11.5px;fill:var(--muted)}
svg text.v{fill:var(--muted);font-size:12.5px} svg tspan.vb{fill:var(--ink);font-weight:600;font-size:13.5px}
svg text.t{fill:var(--ink);font-size:12px}
svg .track{fill:#f0efea} svg .bar{fill:var(--accent)} svg .bar.old{fill:var(--accent);opacity:.38}
svg .target{stroke:var(--ink);stroke-width:1.2;stroke-dasharray:4 3}
.caveat{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding-left:10px;margin:10px 0 0}
.summary{margin:0 0 14px;color:var(--muted)}
.chip{display:inline-block;font-size:12px;line-height:1.6;padding:0 8px;border-radius:999px;background:#efeee9;color:#4a4d52;margin-right:4px;white-space:nowrap}
.chip.feat,.chip.fix{background:var(--accent-soft);color:var(--accent)}
.timeline{list-style:none;margin:0;padding:0}
.timeline .day{font-weight:600;color:var(--muted);font-size:13px;margin:18px 0 6px}
.timeline .commit{display:flex;gap:14px;padding:8px 0;border-top:1px solid var(--line)}
.timeline .time{color:var(--muted);font-size:13px;min-width:42px;padding-top:1px}
.timeline .body{flex:1;min-width:0}
.outcome{margin-top:4px;font-size:14px;background:var(--accent-soft);border-radius:6px;padding:6px 10px}
.outcome-label{color:var(--accent);font-weight:600}
.ticks{color:var(--muted);font-size:12.5px;margin-left:4px}
.prio-grid,.work-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.count{color:var(--muted);font-weight:400;font-size:13px;margin-left:8px}
ul.issues,ul.closed,ul.plain{list-style:none;padding:0;margin:10px 0 0}
ul.issues li,ul.plain li{padding:7px 0;border-top:1px solid var(--line);font-size:14px}
.chip.kind{font-size:11.5px}
h3.sub{margin:22px 0 4px;font-size:14px;color:var(--muted);font-weight:600}
ul.closed li{color:var(--muted);font-size:14px;padding:3px 0}
.check{color:var(--accent);margin-right:8px}
.cap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}
.cap h3{margin-bottom:8px}
.cap .label{font-size:12px;color:var(--muted);letter-spacing:.05em}
.cap p{margin:2px 0 10px;font-size:14px}
.cap details summary{cursor:pointer;list-style:none;font-size:14px;margin:2px 0 10px}
.cap details summary::-webkit-details-marker{display:none}
.cap details[open] summary{display:none}
.more{color:var(--accent);font-size:12.5px;margin-left:6px}
.missing{background:var(--accent-soft);border-radius:8px;padding:8px 12px;margin-top:4px}
.missing .label{color:var(--accent);font-weight:600}
.missing p{margin:2px 0 0}
.cap .evidence{margin:10px 0 0}
`;

function safeTopLine() {
  try {
    return topLine();
  } catch (error) {
    return notice(`顶部信息生成时出错：${error.message}`);
  }
}

function page() {
  const sections = [
    safeSection("三档能力", "按任务难度分三档，看每个模型在每档的评测通过率离目标还差多少。", tiersSection),
    safeSection("最近改了什么", `最近 ${RECENT_DAYS} 天的提交，新的在上；有验收记录的，附上用户能看到的结果。`, commitsSection),
    safeSection("还开着的问题", "按紧急程度分组。", issuesSection),
    safeSection("各项能力现在怎样", "摘自项目进度页。", capabilitiesSection),
    safeSection("工作线", "正在并行推进的分支、工作目录和待合并的改动。", workSection),
  ];

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>By Your Side · 项目看板</title><style>${CSS}</style></head>
<body><main>
<h1>By Your Side · 项目看板</h1>
${safeTopLine()}
${sections.join("\n")}
<p class="evidence" style="margin-top:56px">本页由 npm run dashboard 从仓库现有数据生成，不手工编辑；重新运行即可刷新。</p>
</main></body></html>
`;
}

mkdirSync(OUT_DIR, { recursive: true });

const outFile = join(OUT_DIR, "index.html");

writeFileSync(outFile, page());

console.log(`项目看板已生成：${outFile}`);
