/** 扩展内构建替换 agent/src/node-agent-loop.ts：扩展里的会话必须走 SessionCreateOptions.loop，不能用 pi-coding-agent 的 AgentSession。 */
const unavailable = (): never => {
  throw new Error("扩展里不能创建本机会话：请传入 loop 选项（pi-agent-core 循环）");
};

export const createNodeModelRuntime = unavailable;

export const createNodeLoop = unavailable;
