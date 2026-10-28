import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";

interface CdpEvalResult {
  result?: { type?: string; value?: unknown; objectId?: string; subtype?: string; className?: string; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function invokeBareFunction(code: string): string {
  const body = code.trim().replace(/;*\s*(\/\/[^\n]*)?$/, "");
  return /^(async\s+)?(\(\s*\)\s*=>|function\s*[\w$]*\s*\(\s*\))/.test(body) ? `(${body}\n)()` : code;
}

async function readContext(tabId: number): Promise<number> {
  const tree = await sendCommand<{ frameTree?: { frame?: { id?: unknown } } }>(tabId, "Page.getFrameTree", {}, undefined, 2_000);
  const frameId = tree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || !frameId) throw refused("无法确认读取文档。");
  const world = await sendCommand<{ executionContextId?: unknown }>(tabId, "Page.createIsolatedWorld", {
    frameId, worldName: `sideagent-readonly-${crypto.randomUUID()}`,
  }, undefined, 2_000);
  const contextId = world.executionContextId;
  if (typeof contextId !== "number" || !Number.isInteger(contextId)) throw refused("无法建立隔离只读环境。");
  return contextId;
}

const READ_ONLY_MESSAGE = "JS 只允许读取页面和计算数据；点击、填写、导航和请求请使用对应的专用工具。";

function refused(detail: string): Error {
  return Object.assign(new Error(`${detail} ${READ_ONLY_MESSAGE}`), { executionFact: "not_executed" as const });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused("无法安全读取脚本返回值。");
  return value as Record<string, unknown>;
}

/** Inspector descriptors contain data values; never evaluate JSON.stringify in the page or invoke accessors. */
async function readData(tabId: number, remote: unknown): Promise<unknown> {
  const ancestors = new Set<string>();
  let count = 0;
  let chars = 0;
  const read = async (raw: unknown, depth: number): Promise<unknown> => {
    const value = object(raw);
    if (++count > 10_000 || depth > 16) throw refused("脚本返回值过大或层级过深，请返回较少数据。");
    if (value.type === "undefined") return undefined;
    if (value.type === "string" && typeof value.value === "string") {
      chars += value.value.length;
      if (chars > 1_000_000) throw refused("脚本返回文本过大，请分段读取。");
      return value.value;
    }
    if (value.type === "boolean" && typeof value.value === "boolean") return value.value;
    if (value.type === "number") {
      if (typeof value.value === "number") return value.value;
      if (value.unserializableValue === "NaN") return NaN;
      if (value.unserializableValue === "Infinity") return Infinity;
      if (value.unserializableValue === "-Infinity") return -Infinity;
      if (value.unserializableValue === "-0") return -0;
    }
    if (value.type === "object" && value.subtype === "null") return null;
    const array = value.type === "object" && value.subtype === "array";
    const plain = value.type === "object" && value.subtype === undefined && value.className === "Object";
    if ((!array && !plain) || typeof value.objectId !== "string") throw refused("返回值只能是普通数据；不能返回函数、访问器、Proxy、Promise 或网页对象，请提取具体字段。");
    const id = value.objectId;
    if (ancestors.has(id)) throw refused("脚本返回值含循环引用，请提取具体字段。");
    ancestors.add(id);
    try {
      const properties = await sendCommand<{ result?: unknown; exceptionDetails?: unknown }>(tabId, "Runtime.getProperties", {
        objectId: id, ownProperties: true, generatePreview: false,
      }, undefined, 2_000);
      if (properties.exceptionDetails || !Array.isArray(properties.result)) throw refused("无法安全读取返回对象的自有数据字段。");
      const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
      for (const rawProperty of properties.result) {
        const property = object(rawProperty);
        if (typeof property.name !== "string" || property.symbol !== undefined || !("value" in property) || property.get !== undefined || property.set !== undefined) throw refused("返回对象包含访问器或无法核对的字段，请提取普通数据。");
        if (array && property.name === "length") {
          const length = object(property.value).value;
          if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 10_000) throw refused("返回数组过大，请分段读取。");
          (out as unknown[]).length = length;
          continue;
        }
        if (property.enumerable !== true) continue;
        if (array && !/^(0|[1-9]\d*)$/.test(property.name)) throw refused("返回数组包含额外字段，请改用普通对象。");
        const item = await read(property.value, depth + 1);
        Object.defineProperty(out, property.name, { value: item, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally { ancestors.delete(id); }
  };
  return read(remote, 0);
}

/** A fresh world isolates page-owned Error formatters; V8 checks model code and only data descriptors cross back. */
export async function evaluateJs(
  params: { code: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeExecute?: (() => Promise<void>) & { checkNow?: () => void },
): Promise<{ value: unknown }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);
  if (tab.id == null) throw refused("工作标签页无效。");
  const tabId = tab.id;
  const major = Number(/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1]);
  if (!Number.isInteger(major) || major < 155) throw refused("当前浏览器无法安全执行只读 JS，请升级 Chrome 155 或更新版本；现在可使用 snapshot 和 read_element 读取页面。");
  const code = invokeBareFunction(params.code);
  const contextId = await readContext(tabId);
  const objectGroup = `sideagent-read-${crypto.randomUUID()}`;
  try {
    const result = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", {
      expression: code,
      contextId,
      throwOnSideEffect: true,
      returnByValue: false,
      generatePreview: false,
      awaitPromise: false,
      disableBreaks: true,
      timeout: 3_000,
      objectGroup,
    }, beforeExecute, 5_000);
    if (result.exceptionDetails) throw refused("脚本无法作为只读表达式执行，或读取过程发生异常。");
    return { value: await readData(tabId, result.result) };
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }, undefined, 1_000).catch(error => { console.warn("[readonly-js] releaseObjectGroup failed:", oneLine(error)); });
  }
}
