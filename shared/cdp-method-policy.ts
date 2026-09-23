/**
 * raw CDP escape hatch 的方法与资源边界（纯策略）。
 *
 * 正式工具内部的 sendCommand（upload_file / click / js / screenshot 等）不走本模块。
 * 模型填的 method、label、readonly 不是授权；未知方法默认拒绝。
 */

export const CDP_DENY_PREFIXES = ["Browser.", "Target.", "Debugger.", "Inspector.", "Chrome."] as const;

/**
 * 手写安全子集：只读观察类。期望值须写在测试里，禁止用运行中的集合重算期望。
 * 覆盖仓库内经 raw `cdp` 工具的合法调用（验收 Case 4：Page.getLayoutMetrics）
 * 及工具说明中的只读示例 DOM.getDocument。
 */
export const CDP_SAFE_READONLY_METHODS = [
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.getAttributes",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.querySelector",
  "DOM.querySelectorAll",
] as const;

export type CdpSafeReadonlyMethod = (typeof CDP_SAFE_READONLY_METHODS)[number];

const SAFE_SET: ReadonlySet<string> = new Set(CDP_SAFE_READONLY_METHODS);

const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9_]*$/;

/** 把本地文件送进页面的方法（合法上传走 upload_file）。 */
const FILE_INTO_PAGE_METHODS = new Set<string>([
  "DOM.setFileInputFiles",
]);

/** 任意文件读出/写出或下载行为（DOM.getDocument 不算文件读取）。 */
const FILE_IO_METHODS = new Set<string>([
  "Page.printToPDF",
  "Page.setDownloadBehavior",
  "Page.captureScreenshot",
  "IO.read",
  "IO.close",
  "IO.resolveBlob",
  "Tracing.start",
  "Tracing.end",
  "Tracing.getCategories",
  "Tracing.requestMemoryDump",
  "HeapProfiler.takeHeapSnapshot",
  "HeapProfiler.getHeapObjectId",
  "HeapProfiler.stopTrackingHeapObjects",
  "Memory.getDOMCounters",
  "Memory.forciblyPurgeJavaScriptMemory",
]);

/** Runtime / Page 动态代码；通用写能力不能靠正则证明安全。 */
const DYNAMIC_CODE_METHODS = new Set<string>([
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.addBinding",
  "Runtime.removeBinding",
  "Runtime.compileScript",
  "Runtime.runScript",
  "Runtime.queryObjects",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.setDocumentContent",
  "Page.navigate",
  "Page.reload",
  "Emulation.setEmulatedMedia",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
]);

/** Network/Storage 的 profile 级或跨分区操作。 */
const PROFILE_SCOPE_METHODS = new Set<string>([
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.getAllCookies",
  "Network.getCookies",
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
  "Storage.overrideQuotaForOrigin",
  "Storage.trackCacheStorageForOrigin",
  "Storage.untrackCacheStorageForOrigin",
  "Storage.trackIndexedDBForOrigin",
  "Storage.untrackIndexedDBForOrigin",
]);

export type CdpMethodDenyKind =
  | "invalid_format"
  | "browser_scope"
  | "upload_via_cdp"
  | "file_io"
  | "dynamic_code"
  | "input_injection"
  | "profile_scope"
  | "unsupported";

export type CdpMethodDecision =
  | { allowed: true }
  | { allowed: false; kind: CdpMethodDenyKind; message: string };

export function decideCdpMethod(method: unknown): CdpMethodDecision {
  if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
    return {
      allowed: false,
      kind: "invalid_format",
      message: `非法 CDP method: ${String(method).slice(0, 120)}；格式应为 Domain.command，例如 Page.getLayoutMetrics`,
    };
  }

  for (const prefix of CDP_DENY_PREFIXES) {
    if (method.startsWith(prefix)) {
      return {
        allowed: false,
        kind: "browser_scope",
        message: `CDP method ${method} 被拒绝：${prefix}* 属于浏览器级/越权操作，不允许经 escape hatch 调用`,
      };
    }
  }

  if (FILE_INTO_PAGE_METHODS.has(method)) {
    return {
      allowed: false,
      kind: "upload_via_cdp",
      message: `CDP method ${method} 被拒绝：合法上传请用正式入口 upload_file；通用 CDP 不接受把本地文件送进页面`,
    };
  }

  if (FILE_IO_METHODS.has(method)) {
    return {
      allowed: false,
      kind: "file_io",
      message: `CDP method ${method} 被拒绝：涉及文件读出/写出或下载行为，通用 CDP 未支持`,
    };
  }

  if (DYNAMIC_CODE_METHODS.has(method) || method.startsWith("Runtime.")) {
    return {
      allowed: false,
      kind: "dynamic_code",
      message: `CDP method ${method} 被拒绝：动态代码/仿真改写不能经通用 CDP 默认执行；请用正式工具（如 js）或明确未支持`,
    };
  }

  if (method.startsWith("Input.")) {
    return {
      allowed: false,
      kind: "input_injection",
      message: `CDP method ${method} 被拒绝：原始 Input.* 可绕过正式 click/fill/press；请用对应执行器，通用 CDP 不注入输入`,
    };
  }

  if (PROFILE_SCOPE_METHODS.has(method) || method.startsWith("Storage.") || method.startsWith("Network.")) {
    return {
      allowed: false,
      kind: "profile_scope",
      message: `CDP method ${method} 被拒绝：Network/Storage 的 profile 级或浏览器级操作不在安全子集内`,
    };
  }

  if (SAFE_SET.has(method)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    kind: "unsupported",
    message: `CDP method ${method} 未支持：未知方法默认拒绝；仅允许明确列出的只读观察子集`,
  };
}

/** 模型不得用 CDP 参数里的 sessionId/targetId 换到其他 target。 */
export function decideCdpCommandParams(params: Record<string, unknown> | undefined): CdpMethodDecision {
  if (!params) return { allowed: true };

  if (Object.prototype.hasOwnProperty.call(params, "sessionId") || Object.prototype.hasOwnProperty.call(params, "targetId")) {
    return {
      allowed: false,
      kind: "browser_scope",
      message: "cdp 拒绝模型提供的 sessionId/targetId：只能绑定当前工作标签页，公共 raw CDP 不获得任意 Target 控制权",
    };
  }

  return { allowed: true };
}
