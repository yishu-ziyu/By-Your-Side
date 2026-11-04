import type {Attachment, PageContext} from '../../shared/protocol.js';
import {normalizeSpeech} from './voice-receipt.js';

export interface ControlConfirmSnapshot {
  voiceId: string;
  turn: number;
  expiresAt: number;
  action: 'steer' | 'abort';
  text: string;
  expectedRunId: string | null;
  expectedControlVersion: number;
  context?: PageContext;
  attachments?: Attachment[];
}

// WHY: 口语常把肯定短语连用，例如“是的，确认”；也常带一个语气收尾，例如“确认吧”“好的，可以啊”。
// 只接受纯肯定组合（可带有限语气词），不能吞掉后面的修订/否定：“确认吧，但不要保存”必须整句不匹配。
// 语气词不含“了”，否则“对了”（换个话题）会被误判成肯定。
const AFFIRMATIVE = /^(?:(?:对的|是的|好的|可以|没错|就这个|就这样|确认|继续|照做|没问题|对|是|嗯|好|行)[吧啊呀啦嘛哦呗嘞]?)+$/;

// WHY: “不是”仅接受独立回答，不能把“不是不行”这样的双重否定误当撤销。
const NEGATIVE = /^(?:(?:不用了?|不要了?|不对|不|别动|别|先别|算了|取消|停下?|打住|撤销|作废)(?:吧|啦|呀|啊)?)+(?:谢谢|多谢)?$/;

export function isControlConfirm(text: string): boolean {
  return AFFIRMATIVE.test(normalizeSpeech(text ?? ""));
}

export function isControlReject(text: string): boolean {
  const short = normalizeSpeech(text ?? "");

  return short === "不是" || NEGATIVE.test(short);
}

const TASK_ABORT = /(?:终止|中止|取消|停止|结束|停掉)(?:掉)?(?:当前|这个|这项|刚才的?)?任务|任务(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/;

const NEGATED_ABORT = /(?:不要|别|不用|先别|不想)(?:把)?(?:当前|这个|这项)?(?:任务)?(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/;

const ASKS = /(?:吗|呢|么|没|没有)$|怎么|怎样|如何|能不能|能否|可不可以|是否|有没有|了没|会不会|要不要|是不是|为什么|为啥|什么时候/;

const CONDITIONAL = /之后|以后|然后|[完好]了?(?:再|就)|后(?:告诉|再|叫|通知|跟我|说|提醒)|的话|如果|要是|假如|万一/;

const CLOSING = /^(?:掉|了|吧|啊|呀|丫|啦|哦|哈|呗|谢谢|多谢)*$/;

export function isExplicitTaskAbort(text: string): boolean {
  if (/[?？]/.test(text ?? "")) return false;
  const short = normalizeSpeech(text ?? "");
  const match = short.length <= 16 ? TASK_ABORT.exec(short) : null;

  return !!match && !NEGATED_ABORT.test(short) && !ASKS.test(short) && !CONDITIONAL.test(short)
    && CLOSING.test(short.slice(match.index + match[0].length));
}

