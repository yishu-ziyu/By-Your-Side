import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATES_PATH,
  assertProtectedGatesUntampered,
  loadGates,
  missingReportFields,
  sha256File,
  verifyReport,
  type EvalReport,
} from "../../scripts/eval/lib/verify.js";

const requiredAbsolute = Object.fromEntries(
  loadGates().absolute_checks_required.map((name) => [name, { verdict: "PASS" as const, reason: "fixture" }]),
);

function baseReport(over: Partial<EvalReport> = {}): EvalReport {
  return {
    candidate_sha: "deadbeef",
    baseline_sha: loadGates().review_baseline_sha,
    dirty_tree_flag: false,
    lockfile_sha256: "a".repeat(64),
    artifact_sha256: "b".repeat(64),
    evaluation_revision: sha256File(GATES_PATH),
    dataset_manifest_sha256: "c".repeat(64),
    profile: "fixture",
    run_id: "fixture-1",
    started_at: "2026-09-11T00:00:00.000Z",
    gates_sha256: sha256File(GATES_PATH),
    observations: loadGates().metrics.map((m) => ({
      id: m.id,
      value: m.operator === "eq" ? m.target : m.operator === "lte" ? m.target : m.target,
      samples: m.minimum_samples,
      measurement_mode: m.measurement_mode,
    })),
    absolute_checks: {
      ...requiredAbsolute,
      evaluation_policy_and_oracle_are_independently_protected: { verdict: "BLOCKED", reason: "unprotected" },
      human_review_signed_with_no_unresolved_release_blocker: { verdict: "BLOCKED", reason: "unsigned" },
    },
    human_review: { signed: false },
    ...over,
  };
}

describe("protected eval gates", () => {
  it("loads the locked gates file and matches the protected manifest sha", () => {
    const { sha256 } = assertProtectedGatesUntampered();
    expect(sha256).toBe("61f0bab1557be3330315214057466cb889b23b02d133110cf13fc3544502e748");
    expect(loadGates().metrics).toHaveLength(41);
  });

  it("rejects a deliberately failing candidate", () => {
    const report = baseReport({
      observations: loadGates().metrics.map((m) => ({
        id: m.id,
        value: m.id === "S01" ? 1 : m.target,
        samples: m.minimum_samples,
        measurement_mode: m.measurement_mode,
      })),
    });

    const result = verifyReport(report);
    expect(result.verdict).toBe("FAIL");
    expect(result.metrics.find((m) => m.id === "S01")?.verdict).toBe("FAIL");
  });

  it("returns BLOCKED when human or model evidence is missing", () => {
    const report = baseReport({
      observations: loadGates().metrics.map((m) => ({ id: m.id, missing: true, blocked_reason: "not run" })),
      human_review: { signed: false },
    });

    const result = verifyReport(report);
    expect(result.verdict).toBe("BLOCKED");
    expect(result.absolute.human_review_signed_with_no_unresolved_release_blocker!.verdict).toBe("BLOCKED");
    expect(result.metrics.every((m) => m.verdict === "BLOCKED")).toBe(true);
  });

  it("rejects a tampered gates file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gates-"));
    mkdirSync(dir, { recursive: true });
    const tampered = join(dir, "quality-gates.json");
    const gates = loadGates();
    gates.metrics[0]!.target = 999;
    writeFileSync(tampered, JSON.stringify(gates));
    expect(() => assertProtectedGatesUntampered(tampered)).toThrow(/sha256 mismatch/);
  });

  it("rejects a report that claims a different gates sha", () => {
    const result = verifyReport(baseReport({ gates_sha256: "0".repeat(64) }));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toMatch(/gates_sha256/);
  });

  it("does not let a candidate claim independent protection while main is unprotected", () => {
    const result = verifyReport(
      baseReport({
        absolute_checks: {
          ...requiredAbsolute,
          evaluation_policy_and_oracle_are_independently_protected: "PASS",
        },
      }),
    );

    expect(result.absolute.evaluation_policy_and_oracle_are_independently_protected!.verdict).toBe("FAIL");
  });

  it("lists missing identity fields for release reports", () => {
    expect(missingReportFields({})).toContain("candidate_sha");
    expect(missingReportFields(baseReport())).toEqual([]);
  });
});
