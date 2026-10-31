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

/** 做法按完整来源（协议 + 主机 + 端口）归属：同一注册域下的不同子域常属于不同的人，不能共用。 */
export function operationOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    return parsed.origin.length <= 300 ? parsed.origin : null;
  } catch {
    return null;
  }
}

const SCHEMA_TEXT_KEYS = new Set(["description", "title", "$comment"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SCHEMA_BOUNDS = new Set(["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "minProperties", "maxProperties"]);
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SCHEMA_CHARS = 16_384;
const MAX_SCHEMA_DEPTH = 8;

// 契约只描述数据形状，长期保存、每轮提供给模型：不收常量、枚举、默认值、正则这类能夹带旧答案或秘密的关键词，
// 也不收 TypeBox 认识但这里没审过的关键词。
function isSchemaNode(value: unknown, depth: number): boolean {
  if (!isJsonObject(value) || depth > MAX_SCHEMA_DEPTH) return false;

  return Object.entries(value).every(([key, child]) => {
    if (key === "type") return typeof child === "string" ? SCHEMA_TYPES.has(child) : Array.isArray(child) && child.length > 0 && child.every(item => typeof item === "string" && SCHEMA_TYPES.has(item));
    if (key === "properties") return isJsonObject(child) && Object.entries(child).every(([name, schema]) => INPUT_NAME.test(name) && isSchemaNode(schema, depth + 1));
    if (key === "required") return Array.isArray(child) && child.every(name => typeof name === "string" && INPUT_NAME.test(name));
    if (key === "additionalProperties") return typeof child === "boolean" || isSchemaNode(child, depth + 1);
    if (key === "items") return isSchemaNode(child, depth + 1);
    if (key === "anyOf") return Array.isArray(child) && child.length > 0 && child.length <= 8 && child.every(item => isSchemaNode(item, depth + 1));
    if (SCHEMA_BOUNDS.has(key)) return typeof child === "number" && Number.isFinite(child);

    return false;
  });
}

export function isJsonSchema(value: unknown, input = false): value is JsonSchema {
  if (!isJsonObject(value) || JSON.stringify(value).length > MAX_SCHEMA_CHARS || !isSchemaNode(value, 0)) return false;
  if (!input) return true;

  if (value.type !== "object" || value.additionalProperties !== false) return false;
  if (value.properties !== undefined && !isJsonObject(value.properties)) return false;
  if (isJsonObject(value.properties) && Object.keys(value.properties).some(key => !INPUT_NAME.test(key))) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== "string" || !INPUT_NAME.test(key)))) return false;

  return true;
}

export function sanitizeOperationSchema(schema: JsonSchema): JsonSchema {
  // properties 下面是业务字段名（可以就叫 title、description），只清 schema 自己的说明关键字。
  const sanitize = (value: unknown): unknown => Array.isArray(value)
    ? value.map(sanitize)
    : isJsonObject(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !SCHEMA_TEXT_KEYS.has(key)).map(([key, child]) => [key, key === "properties" && isJsonObject(child)
        ? Object.fromEntries(Object.entries(child).map(([field, fieldSchema]) => [field, sanitize(fieldSchema)]))
        : sanitize(child)]))
      : value;
  const result = sanitize(schema);
  if (!isJsonObject(result)) throw new Error("Schema root must be an object");

  return result;
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
    && typeof value.site === "string" && operationOrigin(value.site) === value.site
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

export function isLearnedOperationResult(value: unknown): value is LearnedOperationResult {
  if (!isJsonObject(value) || typeof value.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(value.operationId)
    || !Number.isInteger(value.steps) || Number(value.steps) < 0) return false;
  if (value.status === "observed" || value.status === "empty") return isOperationSuccessValue(value);
  return ["unavailable", "invalid_input", "invalid_output", "site_mismatch"].includes(String(value.status))
    && typeof value.reason === "string" && value.reason.length <= 600;
}
