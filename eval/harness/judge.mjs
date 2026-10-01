/**
 * Judge: applies each task's success_rule to a trace -> {pass, reason}. Deterministic checks where
 * the rule is mechanical, otherwise an LLM judge via `codex exec` (default model/effort from ~/.codex).
 * Writes runs/<run>/judge/<model>/<task>.json — never modifies traces.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TASKS_FILE } from "./paths.mjs";

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

      try { const j = JSON.parse(m[0]); resolve({ pass: !!j.pass, reason: String(j.reason ?? ""), method: images.length ? "codex+screenshots" : "codex" }); }
      catch { resolve({ pass: null, reason: `judge failed: ${err?.message ?? "unparseable"} :: ${text.slice(0, 300)}`, method: "codex" }); }
    });

    // prompt goes over stdin: long answers/CSVs overflowed argv (spawn E2BIG)
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

export async function judgeOne(task, tr) {
  if (!tr || tr.status === "setup_error") return { pass: false, reason: `no run: ${tr?.errors?.[0]?.slice(0, 200) ?? "missing trace"}`, method: "harness" };
  const det = DETERMINISTIC[task.id]?.(tr);

  if (det) return det;
  const TEXT = /\.(csv|tsv|txt|md|json|html?|xml|svg|js|css)$/i;

  const files = (tr.downloads ?? []).map((d) => {
    if (!TEXT.test(d.name) || d.bytes > 200000) return `--- file ${d.kind}/${d.name} (${d.bytes} bytes; binary or large, content not shown; the file exists on disk) ---`;
    const body = readFileSync(d.path, "utf8");
    const extra = /\.csv$/i.test(d.name) ? `\n(mechanical count: ${Math.max(0, csvRows(body).length - 1)} data rows excluding header)` : "";

    return `--- file ${d.kind}/${d.name} (${d.bytes} bytes)${extra} ---\n${body.slice(0, 20000)}`;
  }).join("\n");

  const prompt = [
    "You are grading one run of a browser side-panel AI assistant. Apply the task's success rule strictly to the evidence below.",
    "Do not browse or run commands; judge only from the evidence. If the rule requires a file (e.g. CSV) and no file is in the evidence, it fails.",
    "Attached images: the FINAL screenshot of the whole browser window (task page on the left, assistant side panel on the right) and, if present, the side panel alone. Use them as evidence of the final page state (e.g. translated text visible, checkbox checked, result message shown). The assistant's claims alone are not evidence of page state, but a screenshot showing that state is.",
    'Answer with ONLY a JSON object: {"pass": true|false, "reason": "<one line, <=200 chars>"}',
    "", `TASK ID: ${task.id}`, `START URL: ${task.site_url}`, `USER PROMPT: ${task.prompt}`, `SUCCESS RULE: ${task.success_rule}`,
    "", `RUN STATUS: ${tr.status}`, `FINAL PAGE: ${JSON.stringify(tr.final_page)}`, `ERRORS: ${JSON.stringify(tr.errors).slice(0, 1500)}`,
    "", "FINAL ANSWER (verbatim from panel):", (tr.final_answer_verbatim || "(none)").slice(0, 30000),
    "", "OTHER PANEL MESSAGES AFTER THE PROMPT:", JSON.stringify((tr.panel_messages ?? []).map((m) => m.text)).slice(0, 4000),
    "", "FILES PRODUCED:", files || "(none)",
  ].join("\n");

  const images = (tr.screenshots ?? []).filter((p) => existsSync(p)).slice(0, 2);

  return codexJudge(prompt, images);
}

export async function judgeRun(runDir, tasks, models, { concurrency = 4, onlyExisting = false, skipJudged = false } = {}) {
  const jobs = [];
  const slugOf = (m) => m.replace(/[^a-z0-9.-]+/gi, "_");

  for (const model of models) for (const task of tasks) {
    if (onlyExisting && !existsSync(join(runDir, slugOf(model), `${task.id}.json`))) continue;

    if (skipJudged && existsSync(join(runDir, "judge", slugOf(model), `${task.id}.json`))) continue;
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
      const v = await judgeOne(task, tr);
      const out = { task: task.id, model, ...v, success_rule: task.success_rule, judged_at: new Date().toISOString() };
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
