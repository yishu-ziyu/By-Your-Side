#!/usr/bin/env npx tsx
/**
 * B02: heap growth under fixed load. Default duration is 2 hours.
 * Pass --ms= to smoke a shorter window; that is not B02 PASS.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskReceiptStore } from "../../agent/src/task-dispatcher.js";
import { REPO_ROOT } from "./lib/verify.js";

function arg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : fallback;
}

const durationMs = Math.max(1_000, Number(arg("--ms", String(2 * 60 * 60 * 1000))) || 2 * 60 * 60 * 1000);
const sampleMs = Math.max(1_000, Number(arg("--sample-ms", "10000")) || 10_000);
const dir = mkdtempSync(join(tmpdir(), "ego-scale-heap-"));
const store = new TaskReceiptStore(dir);
for (let i = 0; i < 20_000; i++) {
  store.claim(`A:req-${i}`, {
    fingerprint: "f",
    pending: false,
    receipt: {
      requestId: `req-${i}`,
      conversationId: "A",
      source: "text",
      action: "start",
      runId: null,
      text: "x",
      targetTitle: "A",
      status: "accepted",
      message: "ok",
      updatedAt: i,
    },
  });
}

type Sample = { at: number; heapMiB: number; rssMiB: number };
const samples: Sample[] = [];
const started = Date.now();
const tick = (): void => {
  store.list("A");
  if (global.gc) global.gc();
  const mem = process.memoryUsage();
  samples.push({ at: Date.now() - started, heapMiB: mem.heapUsed / (1024 * 1024), rssMiB: mem.rss / (1024 * 1024) });
};

tick();
while (Date.now() - started < durationMs) {
  await new Promise((r) => setTimeout(r, sampleMs));
  tick();
}
store.sync();
rmSync(dir, { recursive: true, force: true });

const window = 30 * 60 * 1000;
const first = samples.filter((s) => s.at >= 0 && s.at <= window);
const last = samples.filter((s) => s.at >= durationMs - window);
const mean = (list: Sample[]) => (list.length ? list.reduce((n, s) => n + s.heapMiB, 0) / list.length : null);
const firstMean = mean(first);
const lastMean = mean(last);
const delta = firstMean != null && lastMean != null ? lastMean - firstMean : null;
const full = durationMs >= 2 * 60 * 60 * 1000 - 1_000;
const report = {
  metric: "B02",
  measurement_mode: "reference_host",
  duration_ms: durationMs,
  full_two_hours: full,
  samples: samples.length,
  first_30m_heap_mib: firstMean,
  last_30m_heap_mib: lastMean,
  delta_mib: delta,
  target_mib: 50,
  ok: full && delta != null && delta <= 50,
  blocked_reason: full ? null : "duration shorter than 2 hours; not B02 PASS",
  rss_last_mib: samples.at(-1)?.rssMiB ?? null,
};
const outDir = join(REPO_ROOT, "eval", "runs");
mkdirSync(outDir, { recursive: true });
const path = join(outDir, `scale-heap-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(path, JSON.stringify({ ...report, series: samples }, null, 2));
console.log(JSON.stringify({ ...report, path }, null, 2));
process.exit(report.ok ? 0 : full ? 1 : 0);
