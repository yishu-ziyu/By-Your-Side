import { strict as assert } from "node:assert";
import { test } from "node:test";
import { memoryBackupTiming } from "./memory-backup-timing.js";

test("备份等待、失败退避与成功收尾", () => {
  const events = [
    { at: 100, event: { kind: "changed" as const } },
    { at: 2_000, event: { kind: "changed" as const } },
    { at: 7_000, event: { kind: "timer" as const } },
    { at: 7_100, event: { kind: "failed" as const, failures: 1 } },
    { at: 37_100, event: { kind: "failed" as const, failures: 2 } },
    { at: 97_100, event: { kind: "complete" as const } },
  ];
  assert.deepEqual(events.map(({ at, event }) => memoryBackupTiming(at, event)), [
    { kind: "schedule", at: 5_100 }, { kind: "schedule", at: 7_000 }, { kind: "run" },
    { kind: "schedule", at: 37_100 }, { kind: "schedule", at: 97_100 }, { kind: "clear" },
  ]);
});
