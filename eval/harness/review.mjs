#!/usr/bin/env node
/**
 * Failure-review page for one eval run: node eval/harness/review.mjs <runDir> [--all]
 * Writes <runDir>/review.html (one self-contained file; screenshots are relative <img> links into the run dir).
 * One card per task that did not pass (fail / undeterminable / judge_error) in some model spec, grouped by tier
 * then category; --all also shows passed and not-yet-judged results. The reviewer marks each result
 * 能接受 / 不能接受 / 判错了 (+ optional note); marks live in the browser's localStorage and are exported as
 * review-<runId>.json. Reads only: <spec slug>/<task>.json, .trace.jsonl, -page.png, -panel.png, .png and
 * judge/<spec slug>/<task>.json (see job.mjs, judge.mjs); pass rates follow analyze.py.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EVAL_DIR, TASKS_FILE } from "./paths.mjs";

const args = process.argv.slice(2);

const SHOW_ALL = args.includes("--all");

const runArg = args.find((a) => !a.startsWith("--"));

if (!runArg) { console.error("usage: node eval/harness/review.mjs <runDir> [--all]"); process.exit(2); }

const RUN = resolve(runArg);

const meta = existsSync(join(RUN, "run.json")) ? JSON.parse(readFileSync(join(RUN, "run.json"), "utf8")) : {};

const RUN_ID = meta.runId ?? basename(RUN);

const CAP_MIN = meta.capMs ? Math.round(meta.capMs / 60000) : 4;


// Same labels as scripts/maintenance/dashboard.mjs.
const CATEGORY_LABELS = {
  page_understanding: "读懂网页", selection_ask: "划词提问", browser_action_single: "单步操作", other: "其他",
  browser_action_multistep: "多步操作", extraction_to_table: "提取成表格", form_fill_no_submit: "填表（不提交）",
  cross_tab: "跨标签", memory_skill: "记忆与技能", research_multi_page: "多页调研", translation: "翻译",
};

const VERDICT = {
  pass: ["判为做对", "ok"], fail: ["判为没做对", "bad"], undeterminable: ["判分时无法确定", "warn"],
  judge_error: ["判分程序出错，没判出来", "warn"], none: ["还没判分", "warn"],
};

const TASKS = new Map(readFileSync(TASKS_FILE, "utf8").split("\n").filter((l) => l.trim()).map((l) => { const t = JSON.parse(l);

 return [t.id, t]; }));

const TIERS = JSON.parse(readFileSync(join(EVAL_DIR, "tasks", "tiers.json"), "utf8")).tiers;

const tierOf = (cat) => Object.entries(TIERS).find(([, s]) => s.categories.includes(cat))?.[0] ?? "-";

const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

const pct = (x) => `${Math.round(x * 100)}%`;

const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim();

 return t.length > n ? `${t.slice(0, n)}…` : t; };

const relUrl = (...parts) => parts.map(encodeURIComponent).join("/");

const localTime = (d) => new Date(d).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

// ---------- load results ----------

const configs = (meta.models ?? []).length ? meta.models.slice() : [];

const slugDirs = readdirSync(RUN, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "judge" && !d.name.startsWith("_")).map((d) => d.name);

const results = []; // one per (config, task)

for (const slug of slugDirs) {
  for (const f of readdirSync(join(RUN, slug)).filter((f) => /^BYS-\d+\.json$/.test(f))) {
    const tr = readJson(join(RUN, slug, f));

    if (!tr?.id) continue;
    const model = tr.model ?? slug;

    if (!configs.includes(model)) configs.push(model);
    const judge = readJson(join(RUN, "judge", slug, f));
    const task = TASKS.get(tr.id) ?? { id: tr.id, category: tr.category, prompt: tr.prompt, site_url: tr.site_url };
    const invalid = tr.status === "setup_error" || (tr.errors ?? []).some((e) => e.includes("额度用完"));
    results.push({ slug, model, tr, judge, task, verdict: judge?.verdict ?? "none", invalid, tier: tierOf(task.category) });
  }
}

const configLabel = (spec) => {
  const [main, fast] = spec.split("+");
  const name = (s) => s.slice(s.indexOf("/") + 1);

  return fast && fast !== main ? `${name(main)}（快速判断用 ${name(fast)}）` : name(main);
};

// ---------- data-only first guess at the cause ----------

function traceEvents(r) {
  const p = join(RUN, r.slug, `${r.tr.id}.trace.jsonl`);

  if (!existsSync(p)) return [];

  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const toolText = (e) => {
  const c = e.data?.result?.content;

  return Array.isArray(c) ? c.map((x) => (x?.type === "text" ? String(x.text ?? "") : "")).join(" ") : JSON.stringify(e.data?.result ?? "");
};

function guessCauses(r) {
  const { tr } = r;
  const ev = traceEvents(r);
  const tags = [];
  const errs = (tr.errors ?? []).join("\n");

  if (r.invalid) tags.push(["测试环境没跑起来（不算助手的问题）", short(tr.errors?.[0], 140)]);

  if (tr.status === "timeout") tags.push([`超时：${CAP_MIN} 分钟内没做完，被测试脚本按停止`, ""]);

  if (tr.status === "error") tags.push(["测试脚本中途出错", short(tr.errors?.find((e) => e.startsWith("harness")), 140)]);

  if (!String(tr.final_answer_verbatim ?? "").trim()) tags.push(["面板里没有任何回复", ""]);

  const toolErrs = ev.filter((e) => e.type === "tool_execution_end" && e.data?.isError);

  if (toolErrs.length) tags.push([`有 ${toolErrs.length} 次操作报错`, `第一条：${e2name(toolErrs[0])} ${short(toolText(toolErrs[0]), 120)}`]);

  const all = errs + "\n" + (tr.final_answer_verbatim ?? "") + "\n" + ev.filter((e) => e.type === "tool_execution_end").map(toolText).join("\n");

  if (all.includes("当前写入已暂停")) tags.push(["出现「当前写入已暂停」：操作被安全锁拦下", ""]);

  const sideFails = ev.filter((e) => e.type === "side_call" && e.data?.outcome === "failed");

  if (sideFails.length) tags.push([`快速判断（辅助模型）失败 ${sideFails.length} 次`, sideFails.map((e) => `${e.data.purpose}${e.data.reason ? `：${e.data.reason}` : ""}`).slice(0, 3).join("；")]);

  const panelErr = (tr.panel_messages ?? []).filter((m) => /error/.test(m.cls ?? ""));

  if (panelErr.length) tags.push(["面板显示了错误提示", short(panelErr[0].text, 140)]);

  const denied = (tr.confirmations ?? []).filter((c) => /deny/.test(c.decision ?? ""));

  if (denied.length) tags.push([`测试脚本替用户拒绝了 ${denied.length} 次确认（涉及提交/发送类操作）`, short(denied[0].text, 120)]);

  if (/MODEL MISMATCH/.test(errs)) tags.push(["实际调用的模型和配置不一致", ""]);

  if (r.task.setup) tags.push(["这题需要预先准备（如先划词、多开标签），测试脚本没做这一步，结果不可信", ""]);

  if (r.verdict === "judge_error") tags.push(["判分程序自己出错了，结果待重判", short(r.judge?.reason, 140)]);

  return tags;
}

function e2name(e) { return e.data?.toolName ?? "操作"; }

// ---------- summary: pass rate per config x tier (same rules as analyze.py) ----------

function summaryHtml() {
  const tierIds = Object.keys(TIERS);
  const head = `<tr><th>配置</th>${tierIds.map((t) => `<th>第 ${esc(t)} 档 · ${esc(TIERS[t].name)}<div class="muted small">目标 ${TIERS[t].target == null ? "不设" : pct(TIERS[t].target)}</div></th>`).join("")}<th>总计</th></tr>`;

  const rows = configs.map((c) => {
    const mine = results.filter((r) => r.model === c);

    const cell = (rs, target) => {
      const valid = rs.filter((r) => !r.invalid);
      const judged = valid.filter((r) => ["pass", "fail", "undeterminable"].includes(r.verdict));
      const passed = judged.filter((r) => r.verdict === "pass").length;
      const pending = valid.length - judged.length;

      if (!rs.length) return `<td class="muted">没有这档的题</td>`;
      const rate = judged.length ? passed / judged.length : null;
      const cls = rate == null || target == null ? "" : rate >= target ? "ok" : "bad";
      const extra = [pending ? `${pending} 条未判出` : "", rs.length - valid.length ? `${rs.length - valid.length} 条环境没跑起来` : ""].filter(Boolean).join("，");

      return `<td><span class="rate ${cls}">${rate == null ? "—" : pct(rate)}</span> <span class="muted small">${passed}/${judged.length} 做对</span>${extra ? `<div class="muted small">${esc(extra)}</div>` : ""}</td>`;
    };

    return `<tr><td><div>${esc(configLabel(c))}</div><div class="evidence mono">${esc(c)}</div></td>${tierIds.map((t) => cell(mine.filter((r) => r.tier === t), TIERS[t].target)).join("")}${cell(mine, null)}</tr>`;
  }).join("");

  const n = results.length, notPass = results.filter((r) => r.verdict !== "pass").length;
  const planned = (meta.tasks?.length ?? 0) * (meta.models?.length ?? 0);

  return `<div class="topline"><span>本次评测 <b class="mono">${esc(RUN_ID)}</b></span><span>已跑完 ${n}${planned ? ` / 计划 ${planned}` : ""} 条</span><span>其中没判为做对的 ${notPass} 条</span>${meta.started_at ? `<span class="muted">开始于 ${esc(localTime(meta.started_at))}</span>` : ""}</div>
<table class="rates">${head}${rows}</table>
<p class="caveat">通过率 = 判为做对 / 已判出结果的题（无法确定算没做对；判分程序出错和环境没跑起来的不计入）。绿色达到目标，红色未达。</p>`;
}

// ---------- cards ----------

function shotHtml(r) {
  const id = r.tr.id;
  const has = (f) => existsSync(join(RUN, r.slug, f));
  const imgs = [[`${id}-page.png`, "网页"], [`${id}-panel.png`, "侧边栏"]].filter(([f]) => has(f));

  if (!imgs.length && has(`${id}.png`)) imgs.push([`${id}.png`, "网页 + 侧边栏"]);

  if (!imgs.length) return `<p class="muted small">没有截图</p>`;

  return `<div class="shots">${imgs.map(([f, label]) => `<figure><img loading="lazy" src="${esc(relUrl(r.slug, f))}" alt="${esc(label)}截图" data-zoom><figcaption>${esc(label)}（结束时）</figcaption></figure>`).join("")}</div>`;
}

function columnHtml(r) {
  const [vLabel, vCls] = VERDICT[r.verdict] ?? VERDICT.none;
  const tags = guessCauses(r);
  const answer = String(r.tr.final_answer_verbatim ?? "").trim();
  const key = `${RUN_ID}|${r.tr.id}|${r.model}`;
  const tools = r.tr.n_tool_calls ?? r.tr.n_steps;

  return `<div class="col">
<div class="cfg">${esc(configLabel(r.model))}</div>
<div class="row"><span class="label">判分结果</span><span class="verdict ${vCls}">${esc(vLabel)}</span>${r.judge?.reason ? `<div class="reason">${esc(r.judge.reason)}</div>` : ""}</div>
<div class="row"><span class="label">助手最后的回复</span>${answer ? `<div class="answer">${esc(answer)}</div>` : `<div class="muted">（没有回复）</div>`}</div>
<div class="row meta muted small">用时 ${r.tr.seconds_total == null ? "—" : `${esc(r.tr.seconds_total)} 秒`} · 调用了 ${tools == null ? "—" : esc(tools)} 次工具 · 状态 ${esc(r.tr.status)}</div>
${tags.length ? `<div class="row guess"><span class="label">初步猜测（只看记录推断，不一定对）</span><ul>${tags.map(([t, d]) => `<li>${esc(t)}${d ? `<div class="muted small">${esc(d)}</div>` : ""}</li>`).join("")}</ul></div>` : ""}
${shotHtml(r)}
<div class="decide" data-key="${esc(key)}" data-task="${esc(r.tr.id)}" data-config="${esc(r.model)}">
<button type="button" data-mark="accept">能接受</button><button type="button" data-mark="reject">不能接受</button><button type="button" data-mark="misjudged">判错了</button>
<input type="text" placeholder="一句话备注（可不填）" maxlength="300">
</div>
</div>`;
}

function cardHtml(task, rs, others) {
  const site = task.site_url ?? rs[0].tr.site_url;

  return `<article class="card review" id="${esc(task.id)}">
<header><h3>${esc(task.id)}</h3><span class="chip">${esc(CATEGORY_LABELS[task.category] ?? task.category)}</span>${others.map((o) => `<span class="chip ok">${esc(configLabel(o.model))} ${esc((VERDICT[o.verdict] ?? VERDICT.none)[0])}</span>`).join("")}</header>
<div class="row"><span class="label">用户说了什么</span><div class="prompt">${esc(task.prompt ?? rs[0].tr.prompt)}</div></div>
<div class="row"><span class="label">在哪个网页</span><a class="mono small" href="${esc(site)}" target="_blank" rel="noreferrer">${esc(site)}</a></div>
<div class="row"><span class="label">怎样算对</span><div>${esc(task.success_rule ?? rs[0].judge?.success_rule ?? "（题库里没有）")}</div></div>
<div class="cols n${rs.length}">${rs.map(columnHtml).join("")}</div>
</article>`;
}

function cardsHtml() {
  const byTask = new Map();

  for (const r of results) { if (!byTask.has(r.tr.id)) byTask.set(r.tr.id, []); byTask.get(r.tr.id).push(r); }

  const order = (r) => configs.indexOf(r.model);
  const groups = new Map(); // tier -> category -> cards
  let shown = 0;

  for (const [, rs] of [...byTask].sort(([a], [b]) => a.localeCompare(b))) {
    rs.sort((a, b) => order(a) - order(b));
    const review = SHOW_ALL ? rs : rs.filter((r) => r.verdict !== "pass" && r.verdict !== "none");

    if (!review.length) continue;
    const others = rs.filter((r) => !review.includes(r));
    const task = rs[0].task;
    const t = rs[0].tier, c = task.category;

    if (!groups.has(t)) groups.set(t, new Map());

    if (!groups.get(t).has(c)) groups.get(t).set(c, []);
    groups.get(t).get(c).push(cardHtml(task, review, others));
    shown += review.length;
  }

  if (!shown) return `<p class="notice">这次没有需要复核的结果${SHOW_ALL ? "" : "（全部判为做对，或还没判分；加 --all 可看全部）"}。</p>`;

  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([t, cats]) => `<section><h2>${t === "-" ? "未分档" : `第 ${esc(t)} 档 · ${esc(TIERS[t].name)}`}</h2>
${[...cats].map(([c, cards]) => `<h3 class="sub">${esc(CATEGORY_LABELS[c] ?? c)} <span class="count">${cards.length} 题</span></h3>${cards.join("\n")}`).join("\n")}</section>`).join("\n");
}

// ---------- page ----------

const CSS = `
:root{--bg:#f7f7f4;--card:#fff;--ink:#1f2328;--muted:#6b7078;--line:#e6e4de;--accent:#2f6f8f;--accent-soft:#e7f0f4;--ok:#3d7a4f;--ok-soft:#e9f3ec;--bad:#a14a3b;--bad-soft:#f6e9e6;--warn:#8a6d2b;--warn-soft:#f5efdf}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{max-width:1180px;margin:0 auto;padding:40px 32px 120px}
h1{font-size:26px;font-weight:600;margin:0 0 6px;letter-spacing:.02em}
h2{font-size:19px;font-weight:600;margin:0 0 4px}
h3{font-size:15px;font-weight:600;margin:0}
section{margin-top:44px}
.lead{color:var(--muted);margin:0 0 18px}
.topline{display:flex;flex-wrap:wrap;gap:6px 28px;align-items:baseline;font-size:14px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.muted{color:var(--muted)} .small{font-size:13px}
.notice{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:10px 14px;margin:8px 0}
.evidence{color:#9a9da3;font-size:12px}
.caveat{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding-left:10px;margin:10px 0 0}
table.rates{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;margin-top:14px;font-size:14px}
table.rates th,table.rates td{text-align:left;vertical-align:top;padding:10px 14px;border-top:1px solid var(--line)}
table.rates th{font-weight:600;border-top:0}
.rate{font-weight:600;font-size:16px}.rate.ok{color:var(--ok)}.rate.bad{color:var(--bad)}
h3.sub{margin:22px 0 10px;font-size:14px;color:var(--muted);font-weight:600}
.count{color:var(--muted);font-weight:400;font-size:13px;margin-left:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.card header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.chip{display:inline-block;font-size:12px;line-height:1.6;padding:0 8px;border-radius:999px;background:#efeee9;color:#4a4d52;white-space:nowrap}
.chip.ok{background:var(--ok-soft);color:var(--ok)}
.row{margin:8px 0}
.label{display:block;font-size:12px;color:var(--muted);letter-spacing:.05em}
.prompt{font-size:15.5px}
.cols{display:grid;gap:16px;margin-top:14px}.cols.n2{grid-template-columns:1fr 1fr}.cols.n3{grid-template-columns:1fr 1fr 1fr}
.col{border-top:1px solid var(--line);padding-top:10px;min-width:0}
.cfg{font-weight:600;font-size:14px;color:var(--accent)}
.verdict{display:inline-block;font-size:13px;padding:0 8px;border-radius:6px}
.verdict.ok{background:var(--ok-soft);color:var(--ok)}.verdict.bad{background:var(--bad-soft);color:var(--bad)}.verdict.warn{background:var(--warn-soft);color:var(--warn)}
.reason{font-size:14px;margin-top:2px}
.answer{white-space:pre-wrap;font-size:14px;background:#faf9f6;border:1px solid var(--line);border-radius:8px;padding:8px 12px;max-height:220px;overflow:auto}
.guess ul{margin:2px 0 0;padding-left:18px;font-size:14px}
.guess{background:var(--accent-soft);border-radius:8px;padding:6px 12px}
.shots{display:flex;gap:10px;margin:10px 0;align-items:flex-start}
.shots figure{margin:0;flex:1 1 0;min-width:0}
.shots figure:nth-child(2){flex:0 0 32%}
.shots img{width:100%;max-height:340px;object-fit:contain;object-position:top;border:1px solid var(--line);border-radius:6px;cursor:zoom-in;background:#fafafa}
.shots figcaption{font-size:12px;color:var(--muted)}
.decide{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
.decide button{font:inherit;font-size:14px;padding:4px 14px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer}
.decide button:hover{border-color:var(--accent)}
.decide button.on[data-mark=accept]{background:var(--ok-soft);border-color:var(--ok);color:var(--ok)}
.decide button.on[data-mark=reject]{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}
.decide button.on[data-mark=misjudged]{background:var(--warn-soft);border-color:var(--warn);color:var(--warn)}
.decide input{flex:1 1 200px;font:inherit;font-size:14px;padding:4px 10px;border:1px solid var(--line);border-radius:8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid var(--line);padding:10px 32px;display:flex;justify-content:center;gap:24px;align-items:center;font-size:14px}
.bar button{font:inherit;font-size:14px;padding:6px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
.zoom{position:fixed;inset:0;background:rgba(20,22,25,.82);display:none;align-items:center;justify-content:center;z-index:10;cursor:zoom-out}
.zoom.open{display:flex}.zoom img{max-width:96vw;max-height:94vh;border-radius:6px;background:#fff}
@media (max-width:820px){.cols.n2,.cols.n3{grid-template-columns:1fr}}
`;

const JS = `
const RUN_ID = ${JSON.stringify(RUN_ID).replaceAll("<", "\\u003c")};
const PREFIX = "bys-review:";
const load = (k) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) || {}; } catch { return {}; } };
const save = (k, v) => localStorage.setItem(PREFIX + k, JSON.stringify(v));
const boxes = [...document.querySelectorAll(".decide")];
function paint(box) {
  const d = load(box.dataset.key);
  box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mark === d.mark));
  const input = box.querySelector("input");
  if (document.activeElement !== input) input.value = d.note || "";
}
function progress() {
  const done = boxes.filter((b) => load(b.dataset.key).mark).length;
  document.getElementById("progress").textContent = "已判断 " + done + " / " + boxes.length;
}
boxes.forEach((box) => {
  paint(box);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mark]");
    if (!b) return;
    const d = load(box.dataset.key);
    d.mark = d.mark === b.dataset.mark ? undefined : b.dataset.mark;
    save(box.dataset.key, d); paint(box); progress();
  });
  box.querySelector("input").addEventListener("input", (e) => { const d = load(box.dataset.key); d.note = e.target.value; save(box.dataset.key, d); });
});
progress();
function exportDecisions() {
  const decisions = boxes.map((b) => ({ task: b.dataset.task, config: b.dataset.config, ...load(b.dataset.key) }))
    .filter((d) => d.mark || d.note).map((d) => ({ task: d.task, config: d.config, mark: d.mark || null, note: d.note || "" }));
  return { runId: RUN_ID, decisions };
}
document.getElementById("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(exportDecisions(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "review-" + RUN_ID + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
const zoom = document.getElementById("zoom");
document.addEventListener("click", (e) => {
  if (e.target.matches("img[data-zoom]")) { zoom.querySelector("img").src = e.target.src; zoom.classList.add("open"); }
  else if (e.target.closest("#zoom")) zoom.classList.remove("open");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") zoom.classList.remove("open"); });
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>评测复核 · ${esc(RUN_ID)}</title><style>${CSS}</style></head>
<body><main>
<h1>评测复核</h1>
<p class="lead">逐题看助手${SHOW_ALL ? "的全部结果" : "没做对的地方"}，判断这个结果你能不能接受，或者是判分本身判错了。判断只存在这台电脑的浏览器里，看完点底部「导出我的判断」。</p>
${summaryHtml()}
${cardsHtml()}
<p class="evidence">生成于 ${esc(localTime(Date.now()))} · node eval/harness/review.mjs ${esc(runArg)}${SHOW_ALL ? " --all" : ""}</p>
</main>
<div class="bar"><span id="progress"></span><button type="button" id="export">导出我的判断</button></div>
<div class="zoom" id="zoom"><img alt="放大的截图"></div>
<script>${JS}</script>
</body></html>
`;

const out = join(RUN, "review.html");

writeFileSync(out, html);

console.log(`${out}  (${results.length} results, ${(html.match(/class="decide"/g) ?? []).length} to review)`);
