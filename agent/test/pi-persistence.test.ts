import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("Pi native persistence survives process exit without replaying earlier prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ego-pi-persistence-"));
  try {
    const run = (phase: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "agent/test/fixtures/pi-persistence-probe.ts", phase, dir], { encoding: "utf8", timeout: 60000 }).trim());
    const saved = run("write");
    const reopened = run("read");
    expect(saved.contextFound).toBe(true);
    expect(reopened.contextFound).toBe(true);
    expect(reopened.calls).toBe(1);
    expect(reopened.messages).toBe(6);
    expect(saved.actions).toBe(1);
    expect(reopened.actions).toBe(1);
    expect(reopened.sessionFile).toBe(saved.sessionFile);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 130000);
