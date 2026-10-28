/**
 * 网页里的按住说话：右 ⌥ 的判定见 ptt-keys.ts，
 * 判定结果报给后台；录音与听写在离屏文档里，网页拿不到声音也拿不到 key。
 * 按下、松开、取消时胶囊立刻跟着变（ptt-capsule.ts），不等后台回话。
 */
import type { PttPageMessage } from "../shared/ptt.js";
import { extensionAlive } from "./alive.js";
import { createPttCapsule } from "./ptt-capsule.js";
import { createPttKeys } from "./ptt-keys.js";

/**
 * 阅读卡接手按住说话的样子：选着文字或开着卡时，光标飞到那段字边上听，start/stop 返回 true，胶囊就不出来。
 * 只换「在听」「听写中」由谁画；报给后台的照旧。
 */
export interface PttCompanion { start: () => boolean; stop: () => boolean; cancel: () => void }

export function installPushToTalkKeys(companion?: PttCompanion): void {
  const report = (phase: PttPageMessage["phase"]) => {
    const message: PttPageMessage = { type: "ptt", phase };
    console.debug('[ptt] page_send', phase);
    void chrome.runtime.sendMessage(message).then(reply => {
      if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') throw new Error('后台没有返回语音状态');
      console.debug('[ptt] page_reply', phase, reply.ok, reply.reason);
    }).catch(error => {
      console.error('[ptt] page_send_failed', phase, error instanceof Error ? error.message : String(error));
      companion?.cancel();
      capsule.show({ phase: 'failed', reason: '语音没有接上，请重新按住说话。' });
    });
  };

  const capsule = createPttCapsule();

  const keys = createPttKeys({
    // 光标接手时，上一轮留在底部的结果胶囊一起收掉：同一时刻只有一个 BYS 在听。
    onStart: () => { if (companion?.start()) capsule.hide(); else capsule.show({ phase: "listening" }); report("start"); },
    onStop: () => { if (!companion?.stop()) capsule.show({ phase: "transcribing" }); report("stop"); },
    onCancel: () => { companion?.cancel(); capsule.hide(); report("cancel"); },
  });

  // 只认用户真按的键：网页脚本派发的按键也会进到这里，不挡的话任何网页都能替用户按住说话、打开麦克风。
  for (const type of ["keydown", "keyup"] as const) {
    addEventListener(type, event => { if (event.isTrusted && extensionAlive()) keys.handle({ type, code: event.code, repeat: event.repeat }); }, true);
  }

  addEventListener("blur", event => { if (event.isTrusted) keys.reset(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) keys.reset(); });
}
