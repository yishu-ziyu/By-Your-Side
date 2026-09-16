import type {Attachment, PageContext} from '../../shared/protocol.js';
import type {VoiceInputContext} from '../../shared/voice.js';
import {normalizeSpeech} from './voice-receipt.js';

/**
 * 终止任务的语音读回与已有待确认请求的身份快照。
 * 普通 steer 直接送达；不在语音入口重复确认每条修改。
 * 具体危险网页动作仍由执行层确认。
 */

/** 确认窗口：超过这个时间没回应就作废，避免几天后一句"对"误触发。 */
export const CONTROL_CONFIRM_TTL_MS = 90_000;

/** 保存复述时的要求和执行身份，确认轮的新资料不能替换它们。 */
export interface ControlConfirmSnapshot {
  voiceId: string;
  turn: number;
  expiresAt: number;
  action: 'steer' | 'abort';
  text: string;
  expectedRunId: string | null;
  /** 复述那一刻的控制版本；确认时验的是它，不是确认轮的新版本。 */
  expectedControlVersion: number;
  context?: PageContext;
  attachments?: Attachment[];
}

export function createControlConfirmSnapshot(params: Omit<ControlConfirmSnapshot, 'context' | 'attachments'> & {
  input?: VoiceInputContext;
}): ControlConfirmSnapshot {
  const {input, ...control} = params;
  // 只复制执行资料；语音观察令牌不进入待确认请求，终止也不需要页面材料。
  return structuredClone({
    ...control,
    ...(control.action === 'steer' && input?.context ? {context: input.context} : {}),
    ...(control.action === 'steer' && input?.attachments?.length ? {attachments: input.attachments} : {}),
  });
}

/** 肯定的短回答。只在"上一轮确实问过"时才会被这样解读。 */
// 口语常把肯定短语连用，例如“是的，确认”；也常带一个语气收尾，例如“确认吧”“好的，可以啊”。
// 只接受纯肯定组合（可带有限语气词），不能吞掉后面的修订/否定：“确认吧，但不要保存”必须整句不匹配。
// 语气词不含“了”，否则“对了”（换个话题）会被误判成肯定。
const AFFIRMATIVE = /^(?:(?:对的|是的|好的|可以|没错|就这个|就这样|确认|继续|照做|没问题|对|是|嗯|好|行)[吧啊呀啦嘛哦呗嘞]?)+$/;

/**
 * 否定的短回答：撤回这次控制，不落任何动作。
 *
 * 口语常把否定连用（“不，不用了”“算了，取消”“不用了，谢谢”），只认单短词会让整句回退到
 * 分类器，被当成新的一句控制再问一遍。所以接受纯否定组合，可带“了/吧/谢谢”这类语气与礼貌收尾；
 * 一旦句子里夹进新要求（“不要保存，改成南京”“不是上海，是苏州”）就不再是撤销。
 */
// “不是”仅接受独立回答，不能把“不是不行”这样的双重否定误当撤销。
const NEGATIVE = /^(?:(?:不用了?|不要了?|不对|不|别动|别|先别|算了|取消|停下?|打住|撤销|作废)(?:吧|啦|呀|啊)?)+(?:谢谢|多谢)?$/;

export function isControlConfirm(text: string): boolean {
  return AFFIRMATIVE.test(normalizeSpeech(text ?? ""));
}

export function isControlReject(text: string): boolean {
  const short = normalizeSpeech(text ?? "");
  return short === "不是" || NEGATIVE.test(short);
}

/** 复述用用户自己的原话：转写错了才看得见，比"确认修改吗"有用。 */
export function controlConfirmMessage(text: string): string {
  const quoted = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return `你是说“${quoted}”，对吗？确认后我就照做。`;
}
