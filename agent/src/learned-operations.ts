import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { memoryHostOfUrl } from "../../shared/memory.js";
import { isHostPageProbe } from "../../shared/effect-policy.js";
import { redactCredentialText } from "../../shared/untrusted.js";
import {
  isJsonObject,
  isJsonSchema,
  isLearnedOperationFile,
  isOperationSuccessValue,
  schemaMatches,
  type JsonObject,
  type LearnedOperation,
  type LearnedOperationCandidate,
  type LearnedOperationFailure,
  type LearnedOperationResult,
} from "../../shared/learned-operations.js";
import type { ToolName } from "../../shared/protocol.js";
import type { DocumentPersistence } from "./document-persistence.js";
import { looksSecret } from "./memory-decision.js";
import { ProgramAssertError, runBrowserProgram, type ProgramStep } from "./browser-program.js";
import { siteKey } from "./site-notes.js";

const MAX_OPERATIONS = 100;
const MAX_OFFERED_PER_SITE = 10;

type Draft = Pick<LearnedOperation, "site" | "name" | "purpose" | "inputSchema" | "outputSchema" | "code" | "sourceRunId">;

interface Stored {
  operations: LearnedOperation[];
  readOnly: boolean;
}

export class LearnedOperationStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<LearnedOperation[]> {
    return (await this.load()).operations;
  }

  async get(id: string): Promise<LearnedOperation | null> {
    return (await this.list()).find(operation => operation.id === id) ?? null;
  }

  async operationsFor(url: string): Promise<LearnedOperation[]> {
    const host = memoryHostOfUrl(url);
    if (!host) return [];
    const site = siteKey(host);

    return (await this.list())
      .filter(operation => operation.site === site)
      .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt)
      .slice(0, MAX_OFFERED_PER_SITE);
  }

  async add(draft: Draft): Promise<LearnedOperation> {
    return this.doc.exclusive(async () => {
      const stored = await this.load();
      if (stored.readOnly) throw new Error("保存的做法存在看不懂的内容；为保护原数据，没有覆盖它。");
      const duplicate = stored.operations.find(operation => operation.site === draft.site && operation.code === draft.code);
      if (duplicate) return duplicate;
      if (stored.operations.some(operation => operation.site === draft.site && operation.name === draft.name)) throw new Error("这个网站已经有同名做法；换一个名称再保存。");
      if (stored.operations.length >= MAX_OPERATIONS) throw new Error("保存的做法已达到 100 条；先删除不再使用的做法。");
      const now = Date.now();
      const operation: LearnedOperation = {
        format: 1,
        id: crypto.randomUUID(),
        effect: "read",
        ...draft,
        createdAt: now,
        lastVerifiedAt: now,
        stats: { successes: 0, failures: 0 },
      };
      await this.doc.write(JSON.stringify({ format: 1, operations: [...stored.operations, operation] }) + "\n");

      return operation;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.doc.exclusive(async () => {
      const stored = await this.load();
      if (stored.readOnly) throw new Error("保存的做法存在看不懂的内容；为保护原数据，没有改动它。");
      const operations = stored.operations.filter(operation => operation.id !== id);
      if (operations.length === stored.operations.length) return false;
      await this.doc.write(JSON.stringify({ format: 1, operations }) + "\n");

      return true;
    });
  }

  async recordRun(id: string, result: LearnedOperationResult): Promise<void> {
    await this.doc.exclusive(async () => {
      const stored = await this.load();
      if (stored.readOnly) throw new Error("保存的做法存在看不懂的内容；运行统计没有写入。");
      const now = Date.now();
      const operations = stored.operations.map(operation => {
        if (operation.id !== id) return operation;
        const success = result.status === "observed" || result.status === "empty";
        const stats = {
          successes: operation.stats.successes + (success ? 1 : 0),
          failures: operation.stats.failures + (success ? 0 : 1),
          lastUsedAt: now,
          ...(success ? {} : { lastFailure: result.status }),
        };

        return { ...operation, lastVerifiedAt: success ? now : operation.lastVerifiedAt, stats };
      });
      await this.doc.write(JSON.stringify({ format: 1, operations }) + "\n");
    });
  }

  private async load(): Promise<Stored> {
    const raw = await this.doc.read();
    if (raw === null) return { operations: [], readOnly: false };

    try {
      const parsed: unknown = JSON.parse(raw);
      if (isLearnedOperationFile(parsed)) return { operations: parsed.operations, readOnly: false };
    } catch { /* 损坏内容按只读保护。 */ }

    return { operations: [], readOnly: true };
  }
}

export function learnedOperationHint(operations: readonly LearnedOperation[]): string {
  if (!operations.length) return "";
  const rows = operations.map(operation => JSON.stringify({
    id: operation.id,
    name: operation.name,
    purpose: operation.purpose,
    input: operation.inputSchema,
    version: operation.format,
  })).join("\n");

  return `# Saved website operations\nThese are user-saved, host-validated read-only programs, separate from unverified site notes and bundled site methods. Use learned_operation run only when the user's current request matches a purpose; supply fresh input. The program reads current page data, never an old answer. If it returns unavailable, invalid_output or site_mismatch, do not call it again for this request; continue with ordinary browser tools.\n${rows}`;
}

export function validateLearnedCandidate(candidate: unknown): asserts candidate is LearnedOperationCandidate {
  if (!isJsonObject(candidate)) throw new Error("INVALID_ARGUMENT: 候选做法不是对象。");
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const purpose = typeof candidate.purpose === "string" ? candidate.purpose : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (!name.trim() || name.length > 80 || /[\r\n]/.test(name)) throw new Error("INVALID_ARGUMENT: 做法名称需要是 1–80 字的一行文字。");
  if (!purpose.trim() || purpose.length > 240 || /[\r\n]/.test(purpose)) throw new Error("INVALID_ARGUMENT: 做法说明需要是 1–240 字的一行文字。");
  if (!code.trim() || code.length > 64_000) throw new Error("INVALID_ARGUMENT: 做法程序需要是 1–64000 字。");
  if (!isJsonSchema(candidate.inputSchema, true) || !isJsonSchema(candidate.outputSchema)) throw new Error("INVALID_ARGUMENT: 输入或输出契约不符合受限 JSON Schema。");
  if (!schemaMatches(candidate.inputSchema, candidate.exampleInput)) throw new Error("INVALID_ARGUMENT: 原输入不符合输入契约。");
  if (!schemaMatches(candidate.inputSchema, candidate.validationInput)) throw new Error("INVALID_ARGUMENT: 第二组输入不符合输入契约。");
  if (Value.Equal(candidate.exampleInput, candidate.validationInput)) throw new Error("INVALID_ARGUMENT: 第二组输入必须与原输入不同。");
  if (candidate.validationExpect !== "observed" && candidate.validationExpect !== "empty") throw new Error("INVALID_ARGUMENT: 第二组输入的预期只能是 observed 或 empty。");
  const properties = isJsonObject(candidate.inputSchema.properties) ? Object.keys(candidate.inputSchema.properties) : [];
  if (properties.some(looksSecret)) throw new Error("INVALID_ARGUMENT: 做法不接受密码、验证码、证件或卡号类输入。");
  if (looksSecret(code) || redactCredentialText(code) !== code) throw new Error("INVALID_ARGUMENT: 程序里不能有凭据或秘密值。");
  const literals: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 4) literals.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (isJsonObject(value)) Object.values(value).forEach(collect);
  };
  collect(candidate.exampleInput);
  collect(candidate.validationInput);
  const quoted = literals.find(value => code.includes(JSON.stringify(value)) || code.includes(`'${value}'`) || code.includes('`' + value + '`'));
  if (quoted) throw new Error("INVALID_ARGUMENT: 程序把验证输入写成了常量；请改为读取 input。");
}

const ALLOWED_METHODS = [
  "navigate", "snapshot", "read_element", "read_elements", "scroll", "fetch", "network", "video_captions",
  "waitFor", "waitForElement", "check", "assert", "sleep", "pageInfo", "waitForLoad", "waitForNetworkIdle",
] as const;
const ALLOWED = new Set<string>(ALLOWED_METHODS);
const INTERNAL_READS = new Set<string>(["list_tabs", "get_active_tab", "dialog_info"]);

type FailureStatus = LearnedOperationFailure["status"];

class LearnedOperationError extends Error {
  constructor(readonly status: FailureStatus, reason: string) {
    super(reason);
  }
}

export interface LearnedOperationRuntime {
  id?: string;
  signal?: AbortSignal;
  onStep?(step: ProgramStep): void;
  call(name: ToolName, params: JsonObject, stepId?: string, origin?: "readonly-poll"): Promise<unknown>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const cleanReason = (error: unknown) => redactCredentialText(message(error)).replace(/\s+/g, " ").trim().slice(0, 600);

function operationSite(url: string): string | null {
  const host = memoryHostOfUrl(url);
  return host ? siteKey(host) : null;
}

function assertSite(url: unknown, expected: string): void {
  if (typeof url !== "string" || operationSite(url) !== expected) throw new LearnedOperationError("site_mismatch", `当前页面或请求不属于做法允许的站点 ${expected}。`);
}

export async function runLearnedOperation(
  operation: LearnedOperation,
  rawInput: unknown,
  runtime: LearnedOperationRuntime,
): Promise<LearnedOperationResult> {
  let steps = 0;
  const fail = (status: FailureStatus, reason: string): LearnedOperationFailure => ({ status, operationId: operation.id, reason: cleanReason(reason), steps });

  try {
    if (!schemaMatches(operation.inputSchema, rawInput) || !isJsonObject(rawInput)) return fail("invalid_input", "输入不符合这个做法的参数契约。");
    const input = rawInput;
    const tabs = await runtime.call("list_tabs", {}) as { tabs?: Array<{ id?: number; url?: string; working?: boolean }> };
    const tab = tabs.tabs?.find(item => item.working === true);
    if (!tab?.id || typeof tab.url !== "string") return fail("unavailable", "没有可执行这个做法的当前工作标签页。");
    const tabId = tab.id;
    assertSite(tab.url, operation.site);

    const call = async (name: ToolName, params: JsonObject, stepId?: string, origin?: "readonly-poll"): Promise<unknown> => {
      if (params.tabId !== undefined && params.tabId !== tabId) throw new LearnedOperationError("site_mismatch", "做法试图读取或操作另一个标签页，已停止。");
      for (const key of ["target", "selector"]) {
        const value = params[key];
        if (typeof value === "string" && /^@\d+$/.test(value)) throw new LearnedOperationError("unavailable", "做法包含已经失效的快照编号；请改用持久定位。");
      }
      if (name === "navigate" || name === "fetch") assertSite(params.url, operation.site);
      if (name === "fetch" && (String(params.method ?? "GET").toUpperCase() !== "GET" || (typeof params.body === "string" && params.body.length > 0))) throw new LearnedOperationError("unavailable", "只读做法只能发送不带 body 的 GET 请求。");
      if (name === "js" && !isHostPageProbe(name, params)) throw new LearnedOperationError("unavailable", "只读做法不能执行通用页面 JS。");
      if (!ALLOWED.has(name) && !INTERNAL_READS.has(name) && name !== "js") throw new LearnedOperationError("unavailable", `只读做法不允许调用 ${name}。`);
      const result = await runtime.call(name, params, stepId, origin);
      if (isJsonObject(result)) {
        if (typeof result.url === "string" && /^https?:/.test(result.url)) assertSite(result.url, operation.site);
        if (typeof result.finalUrl === "string" && /^https?:/.test(result.finalUrl)) assertSite(result.finalUrl, operation.site);
      }

      return result;
    };
    const result = await runBrowserProgram({
      code: operation.code,
      input,
      allowedMethods: ALLOWED_METHODS,
      call,
      signal: runtime.signal,
      id: runtime.id,
      onStep: step => {
        if (step.phase === "end") steps += 1;
        runtime.onStep?.(step);
      },
    });
    const latest = await call("list_tabs", {});
    const current = isJsonObject(latest) && Array.isArray(latest.tabs)
      ? latest.tabs.map(item => isJsonObject(item) ? item : null).find(item => item?.id === tabId)
      : null;
    if (!current || typeof current.url !== "string") throw new LearnedOperationError("unavailable", "执行后无法确认原来的标签页。");
    assertSite(current.url, operation.site);
    if (!isOperationSuccessValue(result.value)) throw new LearnedOperationError("invalid_output", "程序没有返回 observed/empty、data、sourceUrl 和 appliedInput。");
    assertSite(result.value.sourceUrl, operation.site);
    if (!Value.Equal(result.value.appliedInput, input)) throw new LearnedOperationError("invalid_output", "程序返回的 appliedInput 与本次输入不一致。");
    if (!schemaMatches(operation.outputSchema, result.value.data)) throw new LearnedOperationError("invalid_output", "程序返回的数据不符合输出契约。");

    return {
      status: result.value.status,
      operationId: operation.id,
      data: result.value.data,
      sourceUrl: result.value.sourceUrl,
      appliedInput: result.value.appliedInput,
      steps: result.steps,
      ...(result.images.length ? { images: result.images } : {}),
    };
  } catch (error) {
    if (error instanceof LearnedOperationError) return fail(error.status, error.message);
    if (error instanceof ProgramAssertError) return fail("unavailable", `第 ${error.assert.failedAt} 步「${error.assert.name}」未满足：${error.assert.reason}`);

    return fail("unavailable", message(error));
  }
}

export function learnedOperationCodeHash(operation: LearnedOperation): string {
  return createHash("sha256").update(operation.code).digest("hex").slice(0, 16);
}
