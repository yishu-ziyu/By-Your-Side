/**
 * 这次操作有什么副作用：按具体请求判定，不只看工具名。
 * ControlGate 仍是最终执行闸门；本模块只回答要不要走闸门 / 要不要授权票据。
 * 不从 control.ts 导入，避免循环依赖。
 */

export type EffectClass = "read" | "write" | "unknown";

export interface EffectDecision {
  class: EffectClass;
  requiresControlGate: boolean;
  needsConsent: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  "snapshot",
  "read_element",
  "list_tabs",
  "get_active_tab",
  "network",
  "screenshot",
  "observe_page",
]);

function methodOf(params?: Record<string, unknown>): string {
  return String(params?.method ?? "GET").toUpperCase();
}

function hasBody(params?: Record<string, unknown>): boolean {
  return typeof params?.body === "string" && params.body.length > 0;
}

/** 空 allowlist：不为任意 POST 搜索接口批量免确认。 */
export const READ_POST_CAPABILITIES: readonly string[] = [];

export function classifyToolEffect(name: string, params?: Record<string, unknown>): EffectDecision {
  if (name === "fetch") {
    const method = methodOf(params);
    if (method === "POST" || hasBody(params)) {
      return {
        class: "write",
        requiresControlGate: true,
        needsConsent: true,
        reason: "fetch POST（或带 body）可能改变服务端状态，不能当只读。",
      };
    }
    return {
      class: "unknown",
      requiresControlGate: true,
      needsConsent: false,
      reason: "GET 名字不能证明业务无副作用；带着登录态的请求仍走控制闸门。",
    };
  }
  if (name === "js") {
    return {
      class: "write",
      requiresControlGate: true,
      needsConsent: false,
      reason: "通用页面 JS 不能用正则证明只读。",
    };
  }
  if (name === "press_key") {
    const key = String(params?.key ?? params?.keys ?? "").toLowerCase();
    const submits = key === "enter" || key === "return" || key.includes("enter");
    return {
      class: submits ? "write" : "write",
      requiresControlGate: true,
      needsConsent: false,
      reason: submits ? "回车/提交可能提交表单。" : "键盘输入按写操作处理。",
    };
  }
  if (READ_TOOLS.has(name)) {
    return {
      class: "read",
      requiresControlGate: false,
      needsConsent: false,
      reason: "声明式只读。",
    };
  }
  return {
    class: "unknown",
    requiresControlGate: true,
    needsConsent: false,
    reason: `未知工具 ${name}，按有副作用处理。`,
  };
}

export function requiresControlGate(name: string, params?: Record<string, unknown>): boolean {
  return classifyToolEffect(name, params).requiresControlGate;
}

export function needsConsentTicket(name: string, params?: Record<string, unknown>): boolean {
  return classifyToolEffect(name, params).needsConsent;
}
