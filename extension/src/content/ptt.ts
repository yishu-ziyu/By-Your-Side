/**
 * 网页里的按住说话（#125，docs/evals/20261007-ptt-dictation.md R1）：右 ⌥ 的判定见 ptt-keys.ts，
 * 判定结果报给后台；录音与听写在离屏文档里，网页拿不到声音也拿不到 key。
 */
import type { PttPageMessage } from "../shared/ptt.js";
import { createPttKeys } from "./ptt-keys.js";

export function installPushToTalkKeys(): void {
  const report = (phase: PttPageMessage["phase"]) => {
    const message: PttPageMessage = { type: "ptt", phase };
    void chrome.runtime.sendMessage(message).catch(() => {});
  };

  const keys = createPttKeys({ onStart: () => report("start"), onStop: () => report("stop"), onCancel: () => report("cancel") });

  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, event => { keys.handle({ type, code: event.code, repeat: event.repeat }); }, true);
  }

  addEventListener("blur", () => keys.reset());
  document.addEventListener("visibilitychange", () => { if (document.hidden) keys.reset(); });
}
