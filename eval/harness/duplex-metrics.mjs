/**
 * 插话评测的读数（eval/tasks/duplex.md）：node eval/harness/duplex-metrics.mjs eval/runs/<run-id> [--tasks eval/tasks/duplex.jsonl]
 * 只读页面自己记的写入记录（result.page_log）和 harness 记的插话时刻（result.interjections），不读扩展的轨迹，
 * 所以量的是用户在页面上看到的，不是程序以为自己做了什么。写 runs/<run>/duplex.json 和 duplex.md。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插话那一刻已经发出去的动作，晚一点落到页面上不算没听；这之后再写旧值才算。 */
export const IN_FLIGHT_MS = 1500;
const WRITES = new Set(["input", "change", "submit", "send", "cart_add", "cart_remove"]);

const matches = (e, m) => (m.type ? e.type === m.type : e.type === "input" || e.type === "change")
  && e.name === m.name && (m.value == null || (m.includes ? String(e.value).includes(m.value) : e.value === m.value));

/** 一题一个配置的读数。没有插话记录或插话没触发时返回 measured=false。 */
export function measure(task, result) {
  const log = Array.isArray(result.page_log) ? result.page_log : [];
  const fired = (result.interjections ?? []).filter((x) => !x.missed);
  const out = { task: task.id, kind: task.kind, measured: fired.length > 0 && log.length > 0, missed: (result.interjections ?? []).filter((x) => x.missed).length, per: [], floor: {} };

  if (!out.measured) return out;

  fired.forEach((x, i) => {
    const spec = task.interject[i] ?? {}, at = x.at_ms, expect = spec.expect ?? {};
    const after = log.filter((e) => e.t >= at);
    // 反映：每项要的值都出现过的那一刻；有一项始终没出现就是 null
    const hits = (expect.reflect ?? []).map((m) => after.find((e) => matches(e, m))?.t ?? null);
    const reflect_s = hits.length && hits.every((h) => h != null) ? (Math.max(...hits) - at) / 1000 : null;
    const stale = (expect.stale ?? []).flatMap((m) => after.filter((e) => matches(e, m)));
    const isStop = !!spec.stop || spec.kind === "stop_text";
    const writes = after.filter((e) => WRITES.has(e.type));

    out.per.push({
      kind: x.kind, text: x.text, at_s: x.at,
      reflect_s, reflected: hits.length ? reflect_s != null : null,
      in_flight_stale: stale.filter((e) => e.t - at < IN_FLIGHT_MS).length,
      wasted: stale.filter((e) => e.t - at >= IN_FLIGHT_MS).length,
      ...(isStop ? { last_write_after_stop_s: writes.length ? (writes.at(-1).t - at) / 1000 : 0, writes_after_stop: writes.filter((e) => e.t - at >= (task.floor?.quiet_after_stop_s ?? 1.5) * 1000).length } : {}),
    });
  });

  const f = task.floor ?? {}, first = fired[0]?.at_ms ?? Infinity;

  if (f.no_submit) out.floor.no_submit = !log.some((e) => e.type === "submit");
  if (f.no_send) out.floor.no_send = !log.some((e) => e.type === "send");
  if (f.no_send_after_interject) out.floor.no_send_after_interject = !log.some((e) => e.type === "send" && e.t >= first);
  if (f.quiet_after_stop_s != null) out.floor.quiet_after_stop = out.per.every((p) => !("writes_after_stop" in p) || p.writes_after_stop === 0);
  out.floor_ok = Object.values(out.floor).every(Boolean);

  return out;
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

function main() {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  const tasksPath = args.includes("--tasks") ? args[args.indexOf("--tasks") + 1] : join(fileURLToPath(new URL("../tasks/duplex.jsonl", import.meta.url)));

  if (!runDir) { console.error("usage: node eval/harness/duplex-metrics.mjs eval/runs/<run-id> [--tasks file]"); process.exit(2); }

  const tasks = new Map(readFileSync(tasksPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((t) => [t.id, t]));
  const rows = [];

  for (const spec of readdirSync(runDir).filter((d) => d !== "judge" && statSync(join(runDir, d)).isDirectory())) {
    for (const file of readdirSync(join(runDir, spec)).filter((f) => /^BYS-D\d+\.json$/.test(f))) {
      const id = file.replace(/\.json$/, ""), task = tasks.get(id);

      if (!task) continue;
      const m = measure(task, JSON.parse(readFileSync(join(runDir, spec, file), "utf8")));
      const jp = join(runDir, "judge", spec, file);
      m.spec = spec;
      m.verdict = existsSync(jp) ? JSON.parse(readFileSync(jp, "utf8")).verdict : null;
      rows.push(m);
    }
  }

  const measured = rows.filter((r) => r.measured);
  const per = measured.flatMap((r) => r.per.map((p) => ({ ...p, task: r.task, spec: r.spec })));
  const summary = {
    results: rows.length, measured: measured.length, missed: rows.length - measured.length,
    pass: measured.filter((r) => r.verdict === "pass").length,
    floor_breaks: measured.filter((r) => r.floor_ok === false).map((r) => `${r.spec}/${r.task}`),
    reflect_median_s: median(per.map((p) => p.reflect_s)),
    never_reflected: per.filter((p) => p.reflected === false).length,
    wasted_writes: per.reduce((n, p) => n + p.wasted, 0),
    stop_tail_median_s: median(per.filter((p) => "last_write_after_stop_s" in p).map((p) => p.last_write_after_stop_s)),
  };

  writeFileSync(join(runDir, "duplex.json"), JSON.stringify({ summary, rows }, null, 2));
  const fmt = (x) => (x == null ? "—" : typeof x === "number" ? x.toFixed(1) : String(x));
  const md = [
    "# 插话评测读数", "",
    `测到 ${summary.measured} / ${summary.results} 条（${summary.missed} 条任务在插话前就结束了，不计）。判分通过 ${summary.pass} 条。`,
    `底线被破：${summary.floor_breaks.length ? summary.floor_breaks.join("、") : "无"}。`,
    `改口到页面上出现新值，中位 ${fmt(summary.reflect_median_s)} 秒；${summary.never_reflected} 次始终没改过来。插话 ${IN_FLIGHT_MS / 1000} 秒后还写旧值 ${summary.wasted_writes} 次。停下后最后一次写入，中位 ${fmt(summary.stop_tail_median_s)} 秒。`,
    "", "| 配置 | 题 | 类型 | 判分 | 改过来用时(秒) | 已发出的旧动作 | 之后还写旧值 | 停下后最后写入(秒) | 底线 |", "|---|---|---|---|---|---|---|---|---|",
    ...measured.flatMap((r) => r.per.map((p) => `| ${r.spec} | ${r.task} | ${r.kind} | ${r.verdict ?? "未判"} | ${fmt(p.reflect_s)} | ${p.in_flight_stale} | ${p.wasted} | ${fmt(p.last_write_after_stop_s)} | ${r.floor_ok ? "守住" : "破了"} |`)),
  ].join("\n");
  writeFileSync(join(runDir, "duplex.md"), md + "\n");
  console.log(md);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
