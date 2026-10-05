/**
 * 这次操作有什么副作用：按具体请求判定，不只看工具名。
 * ControlGate 仍是最终执行闸门；本模块只回答要不要走闸门。
 * 不从 control.ts 导入，避免循环依赖。
 */

export type EffectClass = "read" | "write" | "unknown";

export interface EffectDecision {
  class: EffectClass;
  requiresControlGate: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  "snapshot",
  "read_element",
  "read_elements",
  "list_tabs",
  "get_active_tab",
  "network",
  "screenshot",
  "observe_page",
  "consume_events",
  "dialog_info",
]);

function methodOf(params?: Record<string, unknown>): string {
  return String(params?.method ?? "GET").toUpperCase();
}

function hasBody(params?: Record<string, unknown>): boolean {
  return typeof params?.body === "string" && params.body.length > 0;
}

export function classifyToolEffect(name: string, params?: Record<string, unknown>): EffectDecision {
  if (name === "fetch") {
    const method = methodOf(params);

    if (method === "POST" || hasBody(params)) {
      return {
        class: "write",
        requiresControlGate: true,
        reason: "fetch POST（或带 body）可能改变服务端状态，不能当只读。",
      };
    }

    return {
      class: "unknown",
      requiresControlGate: true,
      reason: "GET 名字不能证明业务无副作用；带着登录态的请求仍走控制闸门。",
    };
  }

  if (name === "js") {
    return {
      class: "write",
      requiresControlGate: true,
      reason: "通用页面 JS 不能用正则证明只读。",
    };
  }

  if (name === "cdp") {
    return {
      class: "write",
      requiresControlGate: true,
      reason: "通用 CDP escape hatch 是 power tool：不做 read/write 分类，全部按写操作走控制闸门。",
    };
  }

  if (name === "upload_file" || name === "file_chooser_set_files") {
    return {
      class: "write",
      requiresControlGate: true,
      reason: "文件上传改变页面状态，按写操作处理。",
    };
  }

  if (name === "accept_dialog" || name === "dismiss_dialog") {
    return {
      class: "write",
      requiresControlGate: true,
      reason: "处理网页 JS dialog 会解除页面阻塞并可能继续业务流，按写操作处理；不等于危险业务授权。",
    };
  }

  if (name === "press_key") {
    const key = String(params?.key ?? params?.keys ?? "").toLowerCase();
    const submits = key === "enter" || key === "return" || key.includes("enter");

    return {
      class: submits ? "write" : "write",
      requiresControlGate: true,
      reason: submits ? "回车/提交可能提交表单。" : "键盘输入按写操作处理。",
    };
  }

  if (READ_TOOLS.has(name)) {
    return {
      class: "read",
      requiresControlGate: false,
      reason: "声明式只读。",
    };
  }

  return {
    class: "unknown",
    requiresControlGate: true,
    reason: `未知工具 ${name}，按有副作用处理。`,
  };
}

export function requiresControlGate(name: string, params?: Record<string, unknown>): boolean {
  return classifyToolEffect(name, params).requiresControlGate;
}

/**
 * 宿主自己写死的只读页面探测（browser_run 的 waitForLoad / pageInfo 读文档状态），按代码全文精确匹配。
 * 它们只读属性、不调用页面函数，所以有页面脚本结果未知时也不算「重做页面脚本」。
 * 模型写的代码（包括 scrollToBottomUntil 的 condition）永远不在这里。
 */
export const HOST_PAGE_PROBES = {
  documentState: "({readyState:document.readyState,href:location.href,timeOrigin:performance.timeOrigin})",
  pageInfo: "({href:location.href,title:document.title,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight},scroll:{x:Math.round(scrollX),y:Math.round(scrollY)},timeOrigin:performance.timeOrigin})",
} as const;

const HOST_PAGE_PROBE_CODES: ReadonlySet<string> = new Set(Object.values(HOST_PAGE_PROBES));

export function isHostPageProbe(name: string, params?: { readonly code?: unknown }): boolean {
  return name === "js" && HOST_PAGE_PROBE_CODES.has(String(params?.code));
}
