#!/usr/bin/env node
// Lint only what is in flight, and fail only on violations that are new.
//
// Why this shape: the repository still carries thousands of legacy anti-slop
// violations (see docs/evals/20260923-anti-slop-vendor.md). A plain `oxlint`
// gate would block every commit until the backlog is gone, so the legacy set
// is recorded in `tools/oxlint/anti-slop-baseline.json` and only growth over
// that baseline fails. Repairing legacy violations is a separate, batched
// effort; shrinking the baseline is part of that work, not a side effect.
//
// Usage:
//   node scripts/lint-changed.mjs                 # everything not on main yet
//   node scripts/lint-changed.mjs --staged        # only the staged files (pre-commit)
//   node scripts/lint-changed.mjs --all           // whole repo, ignores git state
//   node scripts/lint-changed.mjs --write-baseline # regenerate the baseline

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASELINE_PATH = join(ROOT, "tools", "oxlint", "anti-slop-baseline.json");

const OXLINT = join(ROOT, "node_modules", ".bin", "oxlint");

const LINTABLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const BATCH = 200;

const args = new Set(process.argv.slice(2));

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });

  if (result.status !== 0) return [];

  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function inFlightFiles() {
  if (args.has("--all")) {
    return git(["ls-files"]).concat(git(["ls-files", "--others", "--exclude-standard"]));
  }

  if (args.has("--staged")) {
    return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  }

  // Everything that is not on `main` yet: commits since the fork point, the
  // working tree, and untracked files.
  const mergeBase = git(["merge-base", "main", "HEAD"])[0];
  const base = mergeBase ?? "HEAD";
  const changed = git(["diff", "--name-only", "--diff-filter=ACMR", base]);
  const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);

  return [...new Set([...changed, ...staged, ...untracked])];
}

function lint(files) {
  const diagnostics = [];

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);

    const result = spawnSync(OXLINT, ["--format", "json", "--", ...batch], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    });

    // oxlint exits 1 when it reports errors; the JSON is still on stdout.
    const stdout = result.stdout ?? "";

    if (stdout.trim() === "") continue;
    let parsed;

    try {
      parsed = JSON.parse(stdout);
    } catch {
      // A batch whose every file is excluded by ignorePatterns makes oxlint
      // print "No files found to lint" instead of JSON.
      if (/no files/i.test(stdout)) continue;
      process.stderr.write("lint-changed: could not parse oxlint JSON output\n");
      continue;
    }

    for (const entry of parsed.diagnostics ?? []) diagnostics.push(entry);
  }

  return diagnostics;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};

  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    process.stderr.write(`lint-changed: baseline ${relative(ROOT, BASELINE_PATH)} is not valid JSON\n`);
    process.exit(2);
  }
}

// file -> rule -> count. Counts (not line numbers) are the key so that editing
// a file does not silently release its legacy allowance: a file may keep at
// most as many violations of a rule as the baseline recorded.
function countBy(diagnostics) {
  const counts = new Map();

  for (const diagnostic of diagnostics) {
    const file = relative(ROOT, diagnostic.filename);
    const rule = diagnostic.code ?? "<none>";

    if (!counts.has(file)) counts.set(file, new Map());
    const perRule = counts.get(file);
    perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
  }

  return counts;
}

const serializable = (counts) =>
  Object.fromEntries([...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, perRule]) => [file, Object.fromEntries([...perRule.entries()].sort(([a], [b]) => a.localeCompare(b)))]));

const candidates = [...new Set(inFlightFiles())].filter((file) => LINTABLE.has(extname(file)));

if (candidates.length === 0) {
  process.stdout.write("lint-changed: no lintable files in scope\n");
  process.exit(0);
}

const diagnostics = lint(candidates);

const current = countBy(diagnostics);

if (args.has("--write-baseline")) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(serializable(current), null, 2)}\n`);
  const total = [...current.values()].reduce((sum, perRule) => sum + [...perRule.values()].reduce((a, b) => a + b, 0), 0);
  process.stdout.write(`lint-changed: baseline written with ${total} violations across ${current.size} files\n`);
  process.exit(0);
}

const baseline = loadBaseline();

const allowed = (file, rule) => baseline[file]?.[rule] ?? 0;

const legacy = [];

const fresh = [];

for (const [file, perRule] of current) {
  for (const [rule, count] of perRule) {
    const budget = allowed(file, rule);

    if (count <= budget) {
      if (budget > 0) legacy.push({ file, rule, count, budget });
    } else {
      fresh.push({ file, rule, count, budget });
    }
  }
}

for (const entry of fresh) {
  const excess = entry.count - entry.budget;

  const examples = diagnostics
    .filter((d) => relative(ROOT, d.filename) === entry.file && (d.code ?? "<none>") === entry.rule)
    .slice(0, 3);

  process.stderr.write(`\n${entry.file}: ${excess} new ${entry.rule} violation(s) (baseline allows ${entry.budget}, now ${entry.count})\n`);

  for (const example of examples) {
    const label = example.labels?.[0]?.span;
    const where = label ? `:${label.line}:${label.column}` : "";
    process.stderr.write(`  ${entry.file}${where} ${example.message}\n`);
  }
}

if (fresh.length > 0) {
  const newCount = fresh.reduce((sum, entry) => sum + (entry.count - entry.budget), 0);
  process.stderr.write(`\nlint-changed: ${newCount} new violation(s) across ${new Set(fresh.map((f) => f.file)).size} file(s).\n`);
  process.stderr.write("Fix them, or if the pattern is genuinely fine here, relax the rule in oxlint.config.ts and record why.\n");
  process.stderr.write(`Legacy backlog is tracked in ${relative(ROOT, BASELINE_PATH)}; shrinking it is batched work, not something to bypass.\n`);
  process.exit(1);
}

const legacyCount = legacy.reduce((sum, entry) => sum + entry.count, 0);

process.stdout.write(`lint-changed: no new violations (${candidates.length} file(s) checked, ${legacyCount} legacy violation(s) still inside baseline)\n`);
