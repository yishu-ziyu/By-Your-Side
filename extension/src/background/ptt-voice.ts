import { isSubscriptionKey, PTT_SPEAK_RESULT, PTT_SPEECH_KEY, PTT_SPEECH_TARGET, type PttSpeechCommand, type PttSpeechReply } from '../shared/ptt.js';
import type { PttVoice } from './ptt-capsule.js';

/**
 * 念结果的后台一侧（docs/evals/20261007-ptt-speak.md）：记着设置页的订阅 Key 和「做完念出来」开关，
 * 让离屏文档去念。没 Key、Key 不是订阅 Key、或开关关了，就不念（speak 返回 null），也不报错。
 */
export function createPttVoice(notice: (message: string) => void): PttVoice {
  let key = '';
  let on = true;

  const load = () => chrome.storage.local.get([PTT_SPEECH_KEY, PTT_SPEAK_RESULT]).then(got => {
    const stored = got[PTT_SPEECH_KEY];
    key = typeof stored === 'string' && isSubscriptionKey(stored) ? stored.trim() : '';
    on = got[PTT_SPEAK_RESULT] !== false;
  }, () => {});

  void load();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (PTT_SPEECH_KEY in changes || PTT_SPEAK_RESULT in changes)) void load(); });

  const send = (command: PttSpeechCommand) =>
    // SAFETY: 离屏文档对 PttSpeechCommand 只回 PttSpeechReply；没有接收方时 sendMessage 会抛错。
    (chrome.runtime.sendMessage(command) as Promise<PttSpeechReply | undefined>).catch(() => undefined);

  return {
    speak(text) {
      if (!on || !key) return null;

      return send({ target: PTT_SPEECH_TARGET, action: 'speak', text, key }).then(reply => {
        const result: PttSpeechReply = reply ?? { ok: false, reason: 'failed', message: '助手还没启动好' };

        if (!result.ok && result.reason === 'failed') notice(`结果没念出来：${result.message}`);

        return result;
      });
    },
    hush() { void send({ target: PTT_SPEECH_TARGET, action: 'hush' }); },
  };
}
