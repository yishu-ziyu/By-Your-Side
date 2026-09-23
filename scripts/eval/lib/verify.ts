/**
 * Release/eval verifier. Reads locked gates from eval/protected.
 * Missing evidence is BLOCKED. A failing metric is FAIL. Tampered SHA is rejected.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Verdict = "PASS" | "FAIL" | "BLOCKED";

export type MeasurementMode =
  | "offline"
  | "tool_integration"
  | "integration"
  | "ui_mock"
  | "rendered_ui"
  | "native_e2e"
  | "live_model_e2e"
  | "live_audio_e2e"
  | "audio_replay_e2e"
  | "human_acoustic"
  | "human_usability"
  | "human_dogfood"
  | "reference_host";

export interface GateMetric {
  id: string;
  title: string;
  unit: string;
  operator: "eq" | "lte" | "gte";
  target: number;
  minimum_samples: number;
  measurement_mode: MeasurementMode;
  requirement: "required";
  on_missing: "BLOCKED";
}

export interface QualityGates {
  schema_version: number;
  kind: string;
  project: string;
  review_baseline_sha: string;
  policy: {
    aggregation: "ALL_REQUIRED_PASS";
    missing_or_untested: "BLOCKED";
    candidate_may_modify_gate_or_oracle: boolean;
  };
  unfilled_values_block_live_or_release_not_offline_work: Record<string, unknown>;
  absolute_checks_required: string[];
  metrics: GateMetric[];
}

export interface MetricObservation {
  id: string;
  value?: number;
  samples?: number;
  measurement_mode?: MeasurementMode;
  missing?: boolean;
  blocked_reason?: string;
  first_attempt_failed?: boolean;
}

export interface EvalReport {
  candidate_sha?: string;
  baseline_sha?: string;
  dirty_tree_flag?: boolean;
  lockfile_sha256?: string;
  artifact_sha256?: string;
  evaluation_revision?: string;
  dataset_manifest_sha256?: string;
  profile?: string;
  model_parameters?: unknown;
  run_id?: string;
  started_at?: string;
  budget_and_actual_spend?: unknown;
  human_review?: { signed: boolean; reviewer?: string; notes?: string };
  observations?: MetricObservation[];
  absolute_checks?: Record<string, Verdict | { verdict: Verdict; reason?: string }>;
  gates_sha256?: string;
}

export interface MetricResult {
  id: string;
  verdict: Verdict;
  reason: string;
  samples: number;
  value: number | null;
  measurement_mode: MeasurementMode;
}

export interface VerifyResult {
  verdict: Verdict;
  reason: string;
  gates_sha256: string;
  metrics: MetricResult[];
  absolute: Record<string, { verdict: Verdict; reason: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = join(here, "..", "..", "..");

export const PROTECTED_DIR = join(REPO_ROOT, "eval", "protected");

export const GATES_PATH = join(PROTECTED_DIR, "quality-gates.json");

export const GATES_SCHEMA_PATH = join(PROTECTED_DIR, "quality-gates.schema.json");

export const MANIFEST_PATH = join(PROTECTED_DIR, "MANIFEST.json");

export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function loadManifest(): { files: Record<string, { sha256: string; bytes: number }> } {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function loadGates(path: string = GATES_PATH): QualityGates {
  return JSON.parse(readFileSync(path, "utf8")) as QualityGates;
}

export function assertProtectedGatesUntampered(path: string = GATES_PATH): { sha256: string } {
  const manifest = loadManifest();
  const expected = manifest.files["quality-gates.json"]?.sha256;
  const actual = sha256File(path);

  if (!expected) throw new Error("protected manifest missing quality-gates.json sha256");

  if (actual !== expected) {
    throw new Error(`quality-gates sha256 mismatch: expected ${expected}, got ${actual}`);
  }

  if (path !== GATES_PATH && existsSync(GATES_PATH) && sha256File(GATES_PATH) !== actual) {
    throw new Error("candidate gates file does not match the protected revision");
  }

  return { sha256: actual };
}

function compare(operator: GateMetric["operator"], value: number, target: number): boolean {
  if (operator === "eq") return value === target;

  if (operator === "lte") return value <= target;

  return value >= target;
}

function asAbsolute(entry: Verdict | { verdict: Verdict; reason?: string } | undefined): { verdict: Verdict; reason: string } {
  if (!entry) return { verdict: "BLOCKED", reason: "absolute check missing" };

  if (typeof entry === "string") return { verdict: entry, reason: entry === "PASS" ? "reported" : "reported non-pass" };

  return { verdict: entry.verdict, reason: entry.reason ?? entry.verdict };
}

export function verifyReport(report: EvalReport, gates: QualityGates = loadGates()): VerifyResult {
  const { sha256 } = assertProtectedGatesUntampered();

  if (report.gates_sha256 && report.gates_sha256 !== sha256) {
    return {
      verdict: "FAIL",
      reason: `report gates_sha256 ${report.gates_sha256} does not match protected ${sha256}`,
      gates_sha256: sha256,
      metrics: [],
      absolute: {},
    };
  }

  const observations = new Map((report.observations ?? []).map((o) => [o.id, o]));

  const metrics: MetricResult[] = gates.metrics.map((metric) => {
    const obs = observations.get(metric.id);

    if (!obs || obs.missing || obs.value === undefined || obs.value === null) {
      return {
        id: metric.id,
        verdict: "BLOCKED",
        reason: obs?.blocked_reason ?? "missing or untested",
        samples: obs?.samples ?? 0,
        value: null,
        measurement_mode: metric.measurement_mode,
      };
    }

    const samples = obs.samples ?? 0;

    if (samples < metric.minimum_samples) {
      return {
        id: metric.id,
        verdict: "BLOCKED",
        reason: `samples ${samples} < minimum ${metric.minimum_samples}`,
        samples,
        value: obs.value,
        measurement_mode: obs.measurement_mode ?? metric.measurement_mode,
      };
    }

    if (obs.measurement_mode && obs.measurement_mode !== metric.measurement_mode) {
      return {
        id: metric.id,
        verdict: "FAIL",
        reason: `measurement_mode ${obs.measurement_mode} does not match required ${metric.measurement_mode}`,
        samples,
        value: obs.value,
        measurement_mode: obs.measurement_mode,
      };
    }

    const pass = compare(metric.operator, obs.value, metric.target);

    return {
      id: metric.id,
      verdict: pass ? "PASS" : "FAIL",
      reason: pass
        ? `${obs.value} ${metric.operator} ${metric.target}`
        : `${obs.value} does not satisfy ${metric.operator} ${metric.target}`,
      samples,
      value: obs.value,
      measurement_mode: obs.measurement_mode ?? metric.measurement_mode,
    };
  });

  const absolute: Record<string, { verdict: Verdict; reason: string }> = {};

  for (const name of gates.absolute_checks_required) {
    absolute[name] = asAbsolute(report.absolute_checks?.[name]);
  }

  const human = absolute.human_review_signed_with_no_unresolved_release_blocker;

  if (!report.human_review?.signed) {
    absolute.human_review_signed_with_no_unresolved_release_blocker = {
      verdict: "BLOCKED",
      reason: human?.reason === "PASS" ? "human_review.signed is not true" : (human?.reason ?? "human review missing"),
    };
  }

  const protection = absolute.evaluation_policy_and_oracle_are_independently_protected;

  if (protection?.verdict === "PASS") {
    absolute.evaluation_policy_and_oracle_are_independently_protected = {
      verdict: "FAIL",
      reason: "cannot claim independent protection: GitHub main is unprotected and there is no CODEOWNERS/holdout custodian",
    };
  }

  const all = [...metrics.map((m) => m.verdict), ...Object.values(absolute).map((a) => a.verdict)];
  const verdict: Verdict = all.includes("FAIL") ? "FAIL" : all.includes("BLOCKED") ? "BLOCKED" : "PASS";

  const reason =
    verdict === "PASS"
      ? "all required gates passed"
      : verdict === "FAIL"
        ? `FAIL: ${[...metrics.flatMap((m) => m.verdict === "FAIL" ? [m.id] : []), ...Object.entries(absolute).flatMap(([k, v]) => v.verdict === "FAIL" ? [k] : [])].join(", ")}`
        : `BLOCKED: ${[...metrics.flatMap((m) => m.verdict === "BLOCKED" ? [m.id] : []), ...Object.entries(absolute).flatMap(([k, v]) => v.verdict === "BLOCKED" ? [k] : [])].join(", ")}`;

  return { verdict, reason, gates_sha256: sha256, metrics, absolute };
}

export const REQUIRED_REPORT_FIELDS = [
  "candidate_sha",
  "baseline_sha",
  "dirty_tree_flag",
  "lockfile_sha256",
  "artifact_sha256",
  "evaluation_revision",
  "dataset_manifest_sha256",
  "profile",
  "run_id",
  "started_at",
] as const;

export function missingReportFields(report: EvalReport): string[] {
  return REQUIRED_REPORT_FIELDS.filter((field) => report[field] === undefined || report[field] === null || report[field] === "");
}
