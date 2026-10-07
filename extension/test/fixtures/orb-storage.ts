import { ORB_STYLE_STORAGE_KEY } from "../../../shared/voice.js";

/** 测试用的最小扩展环境：存储里选的是粒子球（这些测试的假 canvas 只支持粒子球的画法），不发出存储修改。 */
export const particlesOrbChrome = () => ({
  storage: { local: { get: async () => ({ [ORB_STYLE_STORAGE_KEY]: "particles" }) }, onChanged: { addListener() {}, removeListener() {} } },
  runtime: { getURL: (path: string) => path },
});
