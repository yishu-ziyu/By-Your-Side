/** 扩展内构建替换 `node:perf_hooks`：浏览器自带同名的 performance。 */
export const performance = globalThis.performance;
