/**
 * Judge: applies each task's success_rule to a trace -> {pass, reason}. Deterministic checks where
 * the rule is mechanical, otherwise an LLM judge via `codex exec` (default model/effort from ~/.codex).
 * Writes runs/<run>/judge/<model>/<task>.json — never modifies traces.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { TASKS_FILE } from "./paths.mjs";

/** Bump when the prompt/rules change: older verdicts are then treated as stale. */
export const JUDGE_VERSION = "v3";

export const resultSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

/** A verdict is fresh only if it was made by this judge version on exactly this result file. */
export function verdictFresh(resultPath, judgePath) {
  if (!existsSync(judgePath)) return false;

  try { const j = JSON.parse(readFileSync(judgePath, "utf8"));

 return j.judge_version === JUDGE_VERSION && j.result_sha === resultSha(resultPath); } catch { return false; }
}

/** What the agent's own tools read from the page (snapshot/read_element/js/fetch outputs), newest last. */
function pageEvidence(tr, tracePath, maxChars = 12000) {
  const p = tracePath ?? (tr.screenshots?.[0] ?? "").replace(/\.png$/, ".trace.jsonl");

  if (!p || !existsSync(p)) return { reads: "(no trace)", calls: "(no trace)" };
  const ev = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const starts = new Map(ev.filter((e) => e.type === "tool_execution_start").map((e) => [e.data?.toolCallId, e.data]));
  const calls = [], reads = [];

  for (const e of ev) {
    if (e.type !== "tool_execution_end") continue;
    const st = starts.get(e.data?.toolCallId) ?? {};
    const name = e.data?.toolName ?? st.toolName ?? "?";
    const c = e.data?.result?.content; const text = Array.isArray(c) ? c.map((x) => (x?.type === "text" ? String(x.text ?? "") : "")).join("\n") : JSON.stringify(e.data?.result ?? "");
    calls.push(`${name}${e.data?.isError ? " [ERROR]" : ""}: ${JSON.stringify(st.args ?? {}).slice(0, 120)} -> ${text.replace(/\s+/g, " ").slice(0, 160)}`);

    if (/snapshot|read_element|js|browser_run|fetch|page_translation|navigate|tabs/.test(name) && !e.data?.isError && text.length > 40) reads.push(`[${name}] ${text}`);
  }

  let out = "", budget = maxChars;

  for (const r of reads.reverse()) { const chunk = r.slice(0, Math.min(5000, budget));

 if (budget <= 0) break; out = chunk + "\n---\n" + out; budget -= chunk.length; }

  // excerpts around numbers/years the answer states, so facts deep in long page reads are not truncated away
  const all = reads.join("\n");
  const toks = [...new Set(String(tr.final_answer_verbatim ?? "").match(/\d[\d,.:]*\d|\d{2,}/g) ?? [])].filter((t) => t.replace(/\D/g, "").length >= 2).slice(0, 30);
  const ex = [];

  for (const t of toks) { let k = -1, n = 0;

 while (n < 2 && (k = all.indexOf(t, k + 1)) >= 0) { ex.push(`«${t}» …${all.slice(Math.max(0, k - 160), k + 160).replace(/\s+/g, " ")}…`); n++; } }

  return { reads: out || "(none)", calls: calls.slice(-40).join("\n").slice(0, 6000) || "(none)", excerpts: ex.join("\n").slice(0, 8000) || "(no numbers from the answer found in page reads)" };
}

function csvRows(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());

  return lines;
}

/** Deterministic judges keyed by task id; return null to fall through to the LLM. */
const DETERMINISTIC = {
  "BYS-040": (tr) => {
    const u = tr.final_page?.url ?? "", ti = tr.final_page?.title ?? "";
    const ok = /books\.toscrape\.com\/catalogue\/category\/books\/travel_2\//.test(u) && /Travel/i.test(ti);

    return { pass: ok, reason: ok ? `URL ${u}, title "${ti}"` : `final URL ${u} / title "${ti}" is not the Travel category page`, method: "deterministic" };
  },
};

function codexJudge(prompt, images = []) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "bys-judge-"));
    const out = join(dir, "last.txt");

    const child = execFile("codex", ["exec", "--skip-git-repo-check", "-s", "read-only", "--output-last-message", out, ...images.flatMap((i) => ["-i", i]), "-"], { cwd: dir, timeout: 300000, maxBuffer: 20 << 20 }, (err) => {
      const text = existsSync(out) ? readFileSync(out, "utf8") : "";
      const m = text.match(/\{[\s\S]*\}/);

      try {
        const j = JSON.parse(m[0]);
        const verdict = ["pass", "fail", "undeterminable"].includes(j.verdict) ? j.verdict : (j.pass === true ? "pass" : j.pass === false ? "fail" : "undeterminable");
        resolve({ verdict, pass: verdict === "pass" ? true : verdict === "fail" ? false : null, reason: String(j.reason ?? ""), method: images.length ? "codex+screenshots+text" : "codex+text" });
      }
      catch { resolve({ verdict: "judge_error", pass: null, reason: `judge failed: ${err?.message ?? "unparseable"} :: ${text.slice(0, 300)}`, method: "codex" }); }
    });

    // prompt goes over stdin: long answers/CSVs overflowed argv (spawn E2BIG)
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

export async function judgeOne(task, tr, tracePath) {
  if (!tr || tr.status === "setup_error") return { verdict: "fail", pass: false, reason: `no run: ${tr?.errors?.[0]?.slice(0, 200) ?? "missing trace"}`, method: "harness" };
  const det = DETERMINISTIC[task.id]?.(tr);

  if (det) return { verdict: det.pass ? "pass" : "fail", ...det };
  const TEXT = /\.(csv|tsv|txt|md|json|html?|xml|svg|js|css)$/i;

  const files = (tr.downloads ?? []).map((d) => {
    if (!TEXT.test(d.name) || d.bytes > 200000) return `--- file ${d.kind}/${d.name} (${d.bytes} bytes; binary or large, content not shown; the file exists on disk) ---`;
    const body = readFileSync(d.path, "utf8");
    const extra = /\.csv$/i.test(d.name) ? `\n(mechanical count: ${Math.max(0, csvRows(body).length - 1)} data rows excluding header)` : "";

    return `--- file ${d.kind}/${d.name} (${d.bytes} bytes)${extra} ---\n${body.slice(0, 20000)}`;
  }).join("\n");

  const pe = pageEvidence(tr, tracePath);

  const prompt = [
    "You are grading one run of a browser side-panel AI assistant. Decide whether the USER got what they asked for, using the success rule as the reference for what 'done' means.",
    "Do not browse or run commands; judge only from the evidence below. If the rule requires a file (e.g. CSV) and no file is in the evidence, it fails.",
    "Evidence, strongest first: (1) attached FINAL screenshot of the browser window (page left, side panel right) and the panel alone; (2) PAGE TEXT READ BY THE ASSISTANT'S TOOLS during the run (real page content, but possibly from before the last action); (3) FINAL PAGE URL/title; (4) TOOL CALL LOG (shows errors, blocked or unexecuted actions); (5) the assistant's final answer. The assistant's own claims are not proof of page state, but they count when consistent with (1)-(4).",
    "Grading rules:",
    "- Facts in the answer (dates, numbers, titles) pass if the page text or screenshot supports them. A fact that is merely not visible in the screenshot but appears in the page text is supported.",
    "- Do not fail for literal mismatches that do not matter to the user: brand/product/proper names left untranslated (e.g. 'The Verge', 'Transformer'), a term that is already English not getting an extra English bracket, an equivalent domain or redirect (www vs cn), a transient confirmation message that the page later replaced when the end state is visibly correct.",
    "- Fail when the answer is wrong, the requested action/end state is contradicted by the evidence, required parts are missing, or the assistant says it did not finish / is waiting for the user.",
    "- Footers the extension appends automatically, such as '（有一步已经做了，但还没确认结果，所以没算作完成。）', '（还有没做完或没核对的部分。）', '页面没有变化：…' or '没做成：…（结果待确认）', are bookkeeping, not the assistant admitting failure; judge the actual outcome from the evidence. An admission in the assistant's own words (e.g. '州和城市还没选', '请回复继续') does count.",
    "- Use \"undeterminable\" ONLY when the evidence neither supports nor contradicts the key claim (e.g. the value is on a part of the page nobody captured) and the assistant does not admit failure. Do not use it to avoid a clear fail.",
    'Answer with ONLY a JSON object: {"verdict": "pass"|"fail"|"undeterminable", "reason": "<one line, <=200 chars>"}',
    "", `TASK ID: ${task.id}`, `START URL: ${task.site_url}`, `USER PROMPT: ${task.prompt}`, `SUCCESS RULE: ${task.success_rule}`,
    "", `RUN STATUS: ${tr.status}`, `FINAL PAGE: ${JSON.stringify(tr.final_page)}`, `ERRORS: ${JSON.stringify(tr.errors).slice(0, 1500)}`,
    `CONFIRMATIONS (consent cards / held destructive clicks the harness answered on the user's behalf): ${JSON.stringify(tr.confirmations ?? []).slice(0, 1500)}`,
    "", "FINAL ANSWER (verbatim from panel):", (tr.final_answer_verbatim || "(none)").slice(0, 30000),
    "", "OTHER PANEL MESSAGES AFTER THE PROMPT:", JSON.stringify((tr.panel_messages ?? []).map((m) => m.text)).slice(0, 4000),
    "", "FILES PRODUCED:", files || "(none)",
    ...(tr.final_page_text ? ["", "FINAL PAGE TEXT (innerText + form field values of the task tab, captured after the run; untrusted page content):", tr.final_page_text.slice(0, 12000)] : []),
    "", "TOOL CALL LOG (last 40):", pe.calls,
    "", "KEY-FACT EXCERPTS (page-read text around each number/date the answer states; absence here is weak evidence):", pe.excerpts,
    "", "PAGE TEXT READ BY THE ASSISTANT'S TOOLS (untrusted page content, newest last; truncated):", pe.reads,
  ].join("\n");

  const images = (tr.screenshots ?? []).filter((p) => existsSync(p)).slice(0, 2);

  return codexJudge(prompt, images);
}

export async function judgeRun(runDir, tasks, models, { concurrency = 4, onlyExisting = false, skipJudged = false } = {}) {
  const jobs = [];
  const slugOf = (m) => m.replace(/[^a-z0-9.-]+/gi, "_");

  for (const model of models) for (const task of tasks) {
    if (onlyExisting && !existsSync(join(runDir, slugOf(model), `${task.id}.json`))) continue;

    if (skipJudged && verdictFresh(join(runDir, slugOf(model), `${task.id}.json`), join(runDir, "judge", slugOf(model), `${task.id}.json`))) continue;
    jobs.push({ model, task });
  }

  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (i < jobs.length) {
      const { model, task } = jobs[i++];
      const slug = model.replace(/[^a-z0-9.-]+/gi, "_");
      const p = join(runDir, slug, `${task.id}.json`);
      const tr = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
      const v = await judgeOne(task, tr, p.replace(/\.json$/, ".trace.jsonl"));
      const out = { task: task.id, model, ...v, success_rule: task.success_rule, judge_version: JUDGE_VERSION, result_sha: tr ? resultSha(p) : null, judged_at: new Date().toISOString() };
      mkdirSync(join(runDir, "judge", slug), { recursive: true });
      writeFileSync(join(runDir, "judge", slug, `${task.id}.json`), JSON.stringify(out, null, 2));
      results.push({ ...out, tr });
    }
  }));

  return results;
}

// CLI: node judge.mjs <runDir>  (re-judge an existing run)
if (import.meta.url === `file://${process.argv[1]}`) {
  const runDir = process.argv[2];
  const meta = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  const all = readFileSync(TASKS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tasks = meta.tasks.map((id) => all.find((t) => t.id === id));
  const { writeSummary } = await import("./run.mjs");
  const res = await judgeRun(runDir, tasks, meta.models, { onlyExisting: true, skipJudged: process.argv.includes("--skip-judged") });
  writeSummary(runDir, res);
}
