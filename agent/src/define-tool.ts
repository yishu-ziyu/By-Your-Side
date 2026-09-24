import type { defineTool as piDefineTool } from "@earendil-works/pi-coding-agent";

/**
 * 与 pi-coding-agent 的 defineTool 相同：原样返回工具定义，只为类型推断（dist/core/extensions/types.js）。
 * 自己实现是为了让任务核心在扩展里打包时不引入 pi-coding-agent 的运行时。
 */
// SAFETY: Pi 的实现同样是原样返回并在类型上断言为 ToolDefinition & AnyToolDefinition（src/core/extensions/types.ts）。
export const defineTool = (tool => tool) as typeof piDefineTool;
