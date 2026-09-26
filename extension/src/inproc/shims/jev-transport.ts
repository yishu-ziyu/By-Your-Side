/** 扩展内构建：没有 undici 连接池，Jev 请求走浏览器自带 fetch（连接复用由浏览器管理）。 */
import type { JevResponse } from "../../../../agent/src/jev-transport.js";

export const useJevProxy = (_url: string | undefined): void => {};

export const jevFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<JevResponse> => fetch(url, init);
