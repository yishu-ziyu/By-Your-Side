// Judge an explicit list of result files: node judge-list.mjs <runDir> <listFile> [concurrency]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { judgeOne } from "./judge.mjs";
import { TASKS_FILE } from "./paths.mjs";
const [runDir, listFile, conc = "6"] = process.argv.slice(2);
const all = readFileSync(TASKS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);
let i = 0, done = 0;
await Promise.all(Array.from({ length: Number(conc) }, async () => {
  while (i < files.length) {
    const f = files[i++]; const tr = JSON.parse(readFileSync(join(runDir, f), "utf8"));
    const slug = dirname(f), out = join(runDir, "judge", slug, basename(f));
    if (existsSync(out)) { done++; continue; }
    const task = all.find((t) => t.id === tr.id);
    const v = await judgeOne(task, tr);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ task: tr.id, model: tr.model, ...v, success_rule: task.success_rule, judged_at: new Date().toISOString() }, null, 2));
    console.log(`${++done}/${files.length} ${tr.model} ${tr.id} ${v.pass} ${v.method}`);
  }
}));
