import type { defineTool as piDefineTool } from "@earendil-works/pi-coding-agent";

// SAFETY: Pi 的实现同样是原样返回并在类型上断言为 ToolDefinition & AnyToolDefinition（src/core/extensions/types.ts）。
export const defineTool = (tool => tool) as typeof piDefineTool;
