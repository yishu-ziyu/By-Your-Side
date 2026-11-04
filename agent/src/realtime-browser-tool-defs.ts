import { Type } from 'typebox';
import { createBrowserTools, JS_FALLBACK, TABS_LIST_AT_START, TABS_RESULT_IN_BACKGROUND } from './tools.js';
import { ToolRpc } from './rpc.js';

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

function providerParameters(value: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return value as Record<string, unknown>;
  }
}

function voiceDescription(tool: { name: string; description: string }): string {
  if (tool.name === 'tabs') return tool.description.replace(TABS_LIST_AT_START, '').replace(TABS_RESULT_IN_BACKGROUND, '');

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
