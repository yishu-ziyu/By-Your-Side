#!/usr/bin/env npx tsx
/**
 * B01: event-loop delay with 20_000 receipts and 200 conversations.
 * Does not run 2h heap (see scale-heap.mts).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { TaskReceiptStore } from "../../agent/src/task-dispatcher.js";
import { REPO_ROOT } from "./lib/verify.js";

const dir = mkdtempSync(join(tmpdir(), "ego-scale-loop-"));

const store = new TaskReceiptStore(dir);

for (let s = 0; s < 200; s++) {
  const cid = `C${s}`;

  for (let i = 0; i < 100; i++) {
    const n = s * 100 + i;
    store.claim(`${cid}:req-${n}`, {
      fingerprint: "f",
      pending: false,
      receipt: {
        requestId: `req-${n}`,
        conversationId: cid,
        source: "text",
        action: "start",
        runId: null,
        text: "x",
        targetTitle: cid,
        status: "accepted",
        message: "ok",
        updatedAt: n,
      },
    });
  }
}

store.list("C0");

const histogram = monitorEventLoopDelay({ resolution: 1 });

histogram.enable();

for (let i = 0; i < 1000; i++) {
  store.list(`C${i % 200}`);
  await new Promise((r) => setImmediate(r));
}

histogram.disable();

store.sync();

const p95 = histogram.percentile(95) / 1e6;

const report = {
  metric: "B01",
  measurement_mode: "reference_host",
  receipts: 20_000,
  conversations: 200,
  samples: 1000,
  p95_ms: p95,
  target_ms: 20,
  ok: p95 <= 20,
  voice: "not included",
};

const outDir = join(REPO_ROOT, "eval", "runs");

mkdirSync(outDir, { recursive: true });

const path = join(outDir, `scale-loop-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

writeFileSync(path, JSON.stringify(report, null, 2));

rmSync(dir, { recursive: true, force: true });

console.log(JSON.stringify({ ...report, path }, null, 2));

process.exit(report.ok ? 0 : 1);
