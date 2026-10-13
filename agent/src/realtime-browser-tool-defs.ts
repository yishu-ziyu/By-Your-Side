/**
 * 语音可用的浏览器工具定义（交给 Realtime 的 function 清单）。
 * 单独成文件：定义复用正式工具的参数表（createBrowserTools），会牵出整条工具链；
 * 扩展内构建用 extension/src/inproc/voice/ 下的同名导出替换，内容来自导出的 JSON。
 */
import { Type } from 'typebox';
import { createBrowserTools, JS_FALLBACK, TABS_LIST_AT_START, TABS_RESULT_IN_BACKGROUND } from './tools.js';
import { ToolRpc } from './rpc.js';

// Reuse production tool schemas. This list exposes browser primitives, not another agent loop.
export const REALTIME_BROWSER_TOOL_NAMES = [
  'tabs', 'navigate', 'snapshot', 'read_element', 'read_elements', 'hover',
  'click', 'fill', 'type_text', 'press_key', 'scroll', 'mark', 'page_translation',
] as const;

const names = new Set<string>(REALTIME_BROWSER_TOOL_NAMES);

const guard = Type.Object({
  observationId:Type.String(), operation:Type.Union(['click','fill','press_key','scroll','hover'].map(op=>Type.Literal(op))),
  target:Type.Optional(Type.String()),
});

const tools = createBrowserTools(new ToolRpc()).filter(tool => names.has(tool.name)).map(tool => {
  if (!['click','fill','press_key','scroll','hover'].includes(tool.name)) return tool;

  const base={...tool,parameters:{...tool.parameters,properties:{...(tool.parameters as {properties?: Record<string, unknown>}).properties,
    tabId:Type.Optional(Type.Number()),decisionGuard:Type.Optional(guard)}}};

  return tool.name === 'press_key' ? {...base,parameters:{...base.parameters,properties:{...base.parameters.properties,target:Type.Optional(Type.String())}}} : base;
});

/** 交给 provider 的纯 JSON 参数：TypeBox 生成的对象无循环；序列化失败时退回原对象，不让一次模板异常炸掉整张工具表。 */
function providerParameters(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return value as Record<string, unknown>;
  }
}

/** 语音没有任务首条消息里的标签页清单，也没有回复里的「切过去看」按钮：去掉 tabs 说明里只对文字任务成立的两句。 */
function voiceDescription(tool: { name: string; description: string }): string {
  if (tool.name === 'tabs') return tool.description.replace(TABS_LIST_AT_START, '').replace(TABS_RESULT_IN_BACKGROUND, '');

  // 语音没有 js 工具：只翻一部分、分颜色这类超出专用工具的要求交给 browser_request。
  return tool.description.replace(JS_FALLBACK, ' For anything this tool cannot express (only part of the page, colors, styles), use browser_request.');
}

export const REALTIME_BROWSER_TOOLS = tools.map(tool => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    description: [voiceDescription(tool), ...(tool.promptGuidelines ?? [])].join('\n'),
    parameters: providerParameters(tool.parameters),
  },
}));
