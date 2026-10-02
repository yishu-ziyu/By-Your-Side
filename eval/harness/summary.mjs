import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSummary(runDir, results) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);

    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  const rows = [["task", "model", "pass", "seconds_to_first_output", "seconds_total", "n_steps", "status", "error", "judge_reason"]];

  for (const r of results.sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model))) {
    rows.push([r.task, r.model, r.pass, r.tr?.seconds_to_first_output, r.tr?.seconds_total, r.tr?.n_steps, r.tr?.status, (r.tr?.errors ?? [])[0]?.split("\n")[0]?.slice(0, 200) ?? "", r.reason]);
  }

  writeFileSync(join(runDir, "summary.csv"), rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
  console.log(rows.map((r) => r.slice(0, 7).join("\t")).join("\n"));
}

