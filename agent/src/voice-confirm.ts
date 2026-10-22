import type {Attachment, PageContext} from '../../shared/protocol.js';
import {normalizeSpeech} from './voice-receipt.js';

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

const TASK_ABORT = /(?:终止|中止|取消|停止|结束|停掉)(?:掉)?(?:当前|这个|这项|刚才的?)?任务|任务(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/;

const NEGATED_ABORT = /(?:不要|别|不用|先别|不想)(?:把)?(?:当前|这个|这项)?(?:任务)?(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/;

// 问任务状态（"任务结束了吗""怎么取消任务"）也带"结束/取消…任务"，宿主直接终止就把还在跑的任务杀了。
// 问号要在 normalizeSpeech 之前看：它会去掉全部标点。
const ASKS = /(?:吗|呢|么|没|没有)$|怎么|怎样|如何|能不能|能否|可不可以|是否|有没有|了没|会不会|要不要|是不是|为什么|为啥|什么时候/;

// 把终止放进条件里（"结束任务后告诉我""如果做完就取消任务"）说的是以后的事，不是现在停。
const CONDITIONAL = /之后|以后|然后|[完好]了?(?:再|就)|后(?:告诉|再|叫|通知|跟我|说|提醒)|的话|如果|要是|假如|万一/;

/**
 * 终止说法之后只许跟语气词和礼貌收尾；跟着别的话（"取消任务不暂停就好"）就是在改口或补条件。
 * "嘛"可能是问句，不算收尾；"丫"是转写常把"呀"写错的字。
 */
const CLOSING = /^(?:掉|了|吧|啊|呀|丫|啦|哦|哈|呗|谢谢|多谢)*$/;

/**
 * 明确要求终止当前任务的整句：宿主据此不经模型直接终止。只认短句里的"终止/取消…任务"，
 * 否定（"别终止任务"）、只停说话（"停一下""别说了"）、问句、条件句和先问后改口都不算；这些句子仍交给模型与分类器。
 */
export function isExplicitTaskAbort(text: string): boolean {
  if (/[?？]/.test(text ?? "")) return false;
  const short = normalizeSpeech(text ?? "");
  const match = short.length <= 16 ? TASK_ABORT.exec(short) : null;

  return !!match && !NEGATED_ABORT.test(short) && !ASKS.test(short) && !CONDITIONAL.test(short)
    && CLOSING.test(short.slice(match.index + match[0].length));
}

