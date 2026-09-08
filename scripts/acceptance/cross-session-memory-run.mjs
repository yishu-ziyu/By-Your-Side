#!/usr/bin/env node
/** Independent persistence gate only. Does not claim browser, model, or takeover acceptance. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDir = await mkdtemp(join(tmpdir(), "sideagent-memory-persistence-"));
const storeDir = join(evidenceDir, "synthetic-store");
await mkdir(storeDir);
const probe = `
import { MemoryStore } from './agent/src/memory-store.ts';
const chunks=[]; for await (const c of process.stdin) chunks.push(c);
const input=JSON.parse(Buffer.concat(chunks).toString());
const store=new MemoryStore(input.dir);
const query={text:'整理会议摘要：讨论搜索改版与下周成本确认。',url:'https://research.example/notes'};
let changed=null;
if(input.phase==='create') changed=await store.create({text:'会议摘要请用三条要点。',scope:{kind:'all'},sourceConversationId:'memory-eval-process-a'});
if(input.phase==='update') changed=await store.update({id:input.record.id,expectedVersion:input.record.version,text:'会议摘要请用一段话。',scope:{kind:'all'}});
if(input.phase==='forget') await store.forget({id:input.record.id,expectedVersion:input.record.version});
const selected=await store.select(query);
const resolved=input.old?await store.resolveSelected([{id:input.old.id,version:input.old.version}],query):null;
console.log('MEMORY_EVAL_RESULT '+JSON.stringify({phase:input.phase,pid:process.pid,changed,records:await store.list(),selected,resolved}));
`;
const runs = [], checks = [];
function phase(name, extra = {}) {
  const proc = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: repo, encoding: "utf8", timeout: 30_000,
    input: JSON.stringify({ phase: name, dir: storeDir, ...extra }),
  });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `${name}: ${proc.stderr || proc.stdout}`);
  const line = proc.stdout.split("\n").find((entry) => entry.startsWith("MEMORY_EVAL_RESULT "));
  assert.ok(line, `${name}: no structured production-store result`);
  const result = JSON.parse(line.slice("MEMORY_EVAL_RESULT ".length));
  runs.push(result);
  return result;
}
function check(name, fn) { fn(); checks.push({ name, ok: true }); }
let failure = null;
try {
  const first = phase("create");
  const read = phase("read");
  check("new process preserves acknowledged record and selection", () => {
    assert.notEqual(read.pid, first.pid);
    assert.deepEqual(read.records, [first.changed]);
    assert.deepEqual(read.selected, [first.changed]);
  });
  const updated = phase("update", { record: first.changed, old: first.changed });
  check("update invalidates old selected version", () => {
    assert.ok(updated.changed.version > first.changed.version);
    assert.deepEqual(updated.resolved, []);
  });
  const reread = phase("read", { old: first.changed });
  check("another process retrieves only updated version", () => {
    assert.deepEqual(reread.selected, [updated.changed]);
    assert.deepEqual(reread.resolved, []);
  });
  phase("forget", { record: updated.changed, old: updated.changed });
  const deleted = phase("read", { old: updated.changed });
  check("another process cannot retrieve or inject forgotten record", () => {
    assert.deepEqual(deleted.records, []);
    assert.deepEqual(deleted.selected, []);
    assert.deepEqual(deleted.resolved, []);
  });
  const isolated = phase("read", { dir: join(evidenceDir, "other-personal-store") });
  check("independent store has no shared records", () => assert.deepEqual(isolated.records, []));
} catch (error) {
  failure = String(error?.stack || error);
  process.exitCode = 1;
}
const report = {
  gate: "production memory store across independent Node processes", ok: failure === null,
  checks, runs, failure,
  notEvaluated: ["real model response", "visible save/update/forget UI", "browser restart", "takeover integration", "explicit user request authorization"],
};
await writeFile(join(evidenceDir, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, passed: checks.length, evidence: join(evidenceDir, "result.json"), notEvaluated: report.notEvaluated }, null, 2));
