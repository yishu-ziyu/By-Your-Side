/**
 * 网页里的按住说话（#125，docs/evals/20261007-ptt-dictation.md R1）：右 ⌥ 的判定见 ptt-keys.ts，
 * 判定结果报给后台；录音与听写在离屏文档里，网页拿不到声音也拿不到 key。
 * 按下、松开、取消时胶囊立刻跟着变（ptt-capsule.ts），不等后台回话。
 */
import type { PttPageMessage } from "../shared/ptt.js";
import { createPttCapsule } from "./ptt-capsule.js";
import { createPttKeys } from "./ptt-keys.js";

export function installPushToTalkKeys(): void {
  const report = (phase: PttPageMessage["phase"]) => {
    const message: PttPageMessage = { type: "ptt", phase };
    void chrome.runtime.sendMessage(message).catch(() => {});
  };

  const capsule = createPttCapsule();

  const keys = createPttKeys({
    onStart: () => { capsule.show({ phase: "listening" }); report("start"); },
    onStop: () => { capsule.show({ phase: "transcribing" }); report("stop"); },
    onCancel: () => { capsule.hide(); report("cancel"); },
  });

  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, event => { keys.handle({ type, code: event.code, repeat: event.repeat }); }, true);
  }

  addEventListener("blur", () => keys.reset());
  document.addEventListener("visibilitychange", () => { if (document.hidden) keys.reset(); });
}
