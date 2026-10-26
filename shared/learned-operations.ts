import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = Record<string, unknown>;

export interface LearnedOperationStats {
  successes: number;
  failures: number;
  lastUsedAt?: number;
  lastFailure?: string;
}

export interface LearnedOperation {
  format: 1;
  id: string;
  site: string;
  name: string;
  purpose: string;
  effect: "read";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  code: string;
  sourceRunId: string;
  createdAt: number;
  lastVerifiedAt: number;
  stats: LearnedOperationStats;
}

export interface LearnedOperationFile {
  format: 1;
  operations: LearnedOperation[];
}

export interface LearnedOperationCandidate {
  name: string;
  purpose: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  code: string;
  exampleInput: JsonObject;
  validationInput: JsonObject;
  validationExpect: "observed" | "empty";
}

export interface LearnedOperationSuccess {
  status: "observed" | "empty";
  operationId: string;
  data: unknown;
  sourceUrl: string;
  appliedInput: JsonObject;
  steps: number;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface LearnedOperationFailure {
  status: "unavailable" | "invalid_input" | "invalid_output" | "site_mismatch";
  operationId: string;
  reason: string;
  steps: number;
}

export type LearnedOperationResult = LearnedOperationSuccess | LearnedOperationFailure;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FORBIDDEN_SCHEMA_KEYS = new Set(["$ref", "default", "examples", "example", "const"]);
const MAX_SCHEMA_CHARS = 16_384;

function schemaKeysAllowed(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(schemaKeysAllowed);
  if (!isJsonObject(value)) return true;

  return Object.entries(value).every(([key, child]) =>
    !FORBIDDEN_SCHEMA_KEYS.has(key) && schemaKeysAllowed(child));
}

export function isJsonSchema(value: unknown, input = false): value is JsonSchema {
  if (!isJsonObject(value) || JSON.stringify(value).length > MAX_SCHEMA_CHARS || !schemaKeysAllowed(value)) return false;
  if (!input) return true;

  if (value.type !== "object" || value.additionalProperties !== false) return false;
  if (value.properties !== undefined && !isJsonObject(value.properties)) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== "string"))) return false;

  return true;
}

export function isLearnedOperationCandidate(value: unknown): value is LearnedOperationCandidate {
  if (!isJsonObject(value)) return false;

  return typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 80
    && typeof value.purpose === "string" && value.purpose.trim().length > 0 && value.purpose.length <= 240
    && isJsonSchema(value.inputSchema, true)
    && isJsonSchema(value.outputSchema)
    && typeof value.code === "string" && value.code.trim().length > 0 && value.code.length <= 64_000
    && isJsonObject(value.exampleInput)
    && isJsonObject(value.validationInput)
    && (value.validationExpect === "observed" || value.validationExpect === "empty");
}

export function isLearnedOperation(value: unknown): value is LearnedOperation {
  if (!isJsonObject(value) || !isJsonObject(value.stats)) return false;

  const stats = value.stats;

  return value.format === 1
    && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id)
    && typeof value.site === "string" && value.site.length > 0 && value.site.length <= 253
    && typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 80
    && typeof value.purpose === "string" && value.purpose.trim().length > 0 && value.purpose.length <= 240
    && value.effect === "read"
    && isJsonSchema(value.inputSchema, true)
    && isJsonSchema(value.outputSchema)
    && typeof value.code === "string" && value.code.trim().length > 0 && value.code.length <= 64_000
    && typeof value.sourceRunId === "string" && value.sourceRunId.length > 0 && value.sourceRunId.length <= 96
    && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && typeof value.lastVerifiedAt === "number" && Number.isFinite(value.lastVerifiedAt)
    && Number.isInteger(stats.successes) && Number(stats.successes) >= 0
    && Number.isInteger(stats.failures) && Number(stats.failures) >= 0
    && (stats.lastUsedAt === undefined || (typeof stats.lastUsedAt === "number" && Number.isFinite(stats.lastUsedAt)))
    && (stats.lastFailure === undefined || (typeof stats.lastFailure === "string" && stats.lastFailure.length <= 80));
}

export function isLearnedOperationFile(value: unknown): value is LearnedOperationFile {
  if (!isJsonObject(value) || value.format !== 1 || !Array.isArray(value.operations) || value.operations.length > 100) return false;
  if (!value.operations.every(isLearnedOperation)) return false;

  return new Set(value.operations.map(operation => operation.id)).size === value.operations.length;
}

export function schemaMatches(schema: JsonSchema, value: unknown): boolean {
  try {
    // SAFETY: 所有 schema 先经过 isJsonSchema 的纯 JSON 与引用限制；TSchema 在这里只是 TypeBox 的校验入口。
    return Value.Check(schema as TSchema, value);
  } catch {
    return false;
  }
}

export function isOperationSuccessValue(value: unknown): value is Omit<LearnedOperationSuccess, "operationId" | "steps" | "images"> {
  return isJsonObject(value)
    && (value.status === "observed" || value.status === "empty")
    && "data" in value
    && typeof value.sourceUrl === "string" && value.sourceUrl.length > 0 && value.sourceUrl.length <= 8192
    && isJsonObject(value.appliedInput);
}
