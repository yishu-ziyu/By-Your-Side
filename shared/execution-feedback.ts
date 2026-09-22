/**
 * 执行反馈出口：把一次工具执行的宿主事实翻成「用户此刻需要知道什么」。
 *
 * 分流不按工具耗时或步骤数，而按结果对用户的意义：
 * - capsule：简单操作成功，右上角胶囊显示一条具体短语；是否还需语音由请求判断与宿主共同决定；
 * - voice：留给既有的 Realtime／交付通道，模型组织自然表达，本模块不生成语音正文；
 * - none：读页面、查状态等内部过程，不新增播报。
 *
 * 事实边界由宿主负责：只有 executionFact=executed 的动作才可能生成成功短语；
 * unknown 不能写成成功，not_executed 不等于失败的原因由回执区分。
 * 模型不能把 unknown 改成 verified，也不能靠一句话生成成功状态。
 */
import type { ToolExecutionFact } from './protocol.js';

export const EXECUTION_FEEDBACK_CHANNELS = ['capsule', 'voice', 'none'] as const;

export type ExecutionFeedbackChannel = (typeof EXECUTION_FEEDBACK_CHANNELS)[number];

export const EXECUTION_FEEDBACK_KINDS = ['success', 'pending', 'unknown', 'failure'] as const;

export type ExecutionFeedbackKind = (typeof EXECUTION_FEEDBACK_KINDS)[number];

export const EXECUTION_FEEDBACK_TEXT_MAX = 60;

export const EXECUTION_FEEDBACK_DETAIL_MAX = 120;

/**
 * 有限、具体的胶囊短语：只描述这次动作本身，不声称用户整项要求完成。
 * 范围从窄开始：只有已经贯通的两个动作有短语，其他动作先不显示成功文案。
 */
const CAPSULE_SUCCESS: Record<string, string> = {
  'tabs:switch': '切好了',
  'fill': '已填入',
};

/**
 * 胶囊结束动作只适用于「动作结果用户自己就能看见」的操作：切标签后页面本身变了，
 * 不需要再听一遍。fill 不在此列——填完往往还有保存／提交等待处理部分，语音要保留。
 */
const CAPSULE_CLOSE_ON_SUCCESS = new Set(['tabs:switch']);

export interface ExecutionFeedbackFacts {
  tool: string;
  action?: string;
  executionFact: ToolExecutionFact;
  /** 动作落在哪个标签页（有宿主回执时）；没有就不猜。 */
  tabId?: number;
  /** 回执要点，人话；缺省不写。 */
  detail?: string;
}

export interface ExecutionFeedback {
  /**
   * 去重与过期身份：复用真实调用身份（inputId / toolCallId），不按文案去重。
   * 同一 id 只展示、只回弹一次；createdAt 更旧的反馈不得覆盖更新的。
   */
  id: string;
  channel: ExecutionFeedbackChannel;
  kind: ExecutionFeedbackKind;
  /** 胶囊短语或宿主事实一句话；不是模型叙述。 */
  text: string;
  /** 成功才轻微回弹一次；失败、未知、等待确认不回弹。 */
  bounce: boolean;
  /** 成功胶囊足以确认这次简单动作；不代表用户整条要求不再需要语音。 */
  capsuleCanCloseAction: boolean;
  facts: ExecutionFeedbackFacts;
  inputId?: string;
  runId?: string | null;
  toolCallId?: string;
  createdAt: number;
}

export interface ExecutionFeedbackInput {
  tool: string;
  args?: Record<string, unknown>;
  executionFact: ToolExecutionFact;
  /** 工具回执的 details／data；只读已知字段，不从内容猜结果。 */
  data?: unknown;
  failed?: boolean;
  inputId?: string;
  runId?: string | null;
  toolCallId?: string;
  at?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `${工具}:${动作}` 作为短语表键；没有动作时就是工具名。 */
export function executionFeedbackKey(tool: string, args?: Record<string, unknown>): string {
  const action = asRecord(args ?? null)?.action;

  return typeof action === 'string' && action ? `${tool}:${action}` : tool;
}

/**
 * 一次已登记的直接工具执行 → 反馈记录；读页面/查状态等返回 null（不新增播报）。
 * 调用方只在有真实调用身份时使用结果，缺身份不生成记录（无从去重）。
 */
export function classifyDirectExecutionFeedback(input: ExecutionFeedbackInput): ExecutionFeedback | null {
  const key = executionFeedbackKey(input.tool, input.args);
  const successText = CAPSULE_SUCCESS[key];

  if (!successText) return null;
  const identity = input.toolCallId ? `tool:${input.toolCallId}` : input.inputId ? `input:${input.inputId}` : null;

  if (!identity) return null;
  const action = asRecord(input.args ?? null)?.action;
  const receipt = asRecord(input.data);
  const tabId = typeof receipt?.tabId === 'number' && Number.isInteger(receipt.tabId) ? receipt.tabId : undefined;

  const base = {
    id: identity,
    facts: {
      tool: input.tool,
      ...(typeof action === 'string' && action ? { action } : {}),
      executionFact: input.executionFact,
      ...(tabId != null ? { tabId } : {}),
    } satisfies ExecutionFeedbackFacts,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    runId: input.runId ?? null,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    createdAt: input.at ?? Date.now(),
  };

  // 工具被拦下等用户确认：不是失败，也不是成功；让用户看到等待入口，语音照常解释。
  if (input.executionFact === 'not_executed' && asRecord(input.data)?.held === true) {
    return { ...base, channel: 'capsule', kind: 'pending', text: '等你确认', bounce: false, capsuleCanCloseAction: false };
  }

  if (input.executionFact !== 'executed') {
    const unknown = input.executionFact === 'unknown';

    return {
      ...base,
      channel: 'capsule',
      kind: unknown ? 'unknown' : 'failure',
      text: unknown ? '结果待确认' : '没有执行',
      bounce: false,
      capsuleCanCloseAction: false,
    };
  }

  // 执行已发生但后续处理失败：动作事实保留，也不改写成成功文案。
  if (input.failed) {
    return { ...base, channel: 'capsule', kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false };
  }

  // 证据门槛：执行事实只说明动作发生过，不等于目标达成。缺少具体结果或与要求矛盾时，
  // 不给成功文案也不回弹；保持中性待确认，执行事实原样保留（不改写成 not_executed）。
  const gate = successEvidence(key, input.args, receipt);

  if (!gate.ok) {
    return {
      ...base,
      channel: 'capsule',
      kind: 'unknown',
      text: '结果待确认',
      bounce: false,
      capsuleCanCloseAction: false,
      facts: { ...base.facts, ...(gate.detail ? { detail: gate.detail } : {}) },
    };
  }

  return {
    ...base,
    channel: 'capsule',
    kind: 'success',
    text: successText,
    bounce: true,
    capsuleCanCloseAction: CAPSULE_CLOSE_ON_SUCCESS.has(key),
  };
}

/**
 * 已支持两类动作的成功证据（V2.1；V2.3 起 tabs:switch 必须来自执行后的真实读回）：
 * - tabs:switch：回执目标与要求一致之外，还必须携带执行后读回的核验事实——核验时刻
 *   目标标签确实是已聚焦目标窗口的活动标签、工作目标仍指向它；旧回显回执、缺字段、
 *   读回失败、实际页不符或窗口未聚焦都不产生成功资格；
 * - fill 回执必须带内容核对结果（写入后读回与要求一致）；已执行 ≠ 内容已核对。
 * 回执缺字段或矛盾 → 待确认，附人话说明；不在这里重复读取，也不冒充成功。
 * 执行事实与目标核验分开：核验不通过只是否定成功资格，不把 executed 改写成 not_executed。
 */
function successEvidence(key: string, args: Record<string, unknown> | undefined, receipt: Record<string, unknown> | null): { ok: boolean; detail?: string } {
  if (key === 'tabs:switch') {
    const wanted = asRecord(args ?? null)?.tabId;
    const wantedId = typeof wanted === 'number' && Number.isInteger(wanted) ? wanted : null;
    const actual = receipt?.tabId;

    if (typeof actual !== 'number' || !Number.isInteger(actual)) return { ok: false, detail: '回执没有给出切换后的标签页' };

    if (wantedId != null && actual !== wantedId) {
      return { ok: false, detail: `要求切到标签 ${wantedId}，回执指向 ${actual}` };
    }

    if (wantedId == null) return { ok: false, detail: '请求没有给出目标标签，无法核验' };
    const verification = asRecord(receipt?.verification);

    if (!verification) return { ok: false, detail: '回执未附执行后读回，实际活动页未核验' };
    const activeTabId = typeof verification.activeTabId === 'number' && Number.isInteger(verification.activeTabId) ? verification.activeTabId : null;

    if (verification.verified !== true) {
      // 已知未激活 / 窗口未聚焦 / 读不回来：按事实分别如实说明，都不给成功资格。
      if (activeTabId != null && activeTabId !== wantedId) return { ok: false, detail: `核验时目标页不是活动页，实际活动页为 ${activeTabId}` };

      if (activeTabId != null && verification.windowFocused !== true) return { ok: false, detail: '核验时目标窗口未聚焦，用户当前看不到该页' };

      return { ok: false, detail: '执行后读回失败，未能核验实际活动页' };
    }

    // verified=true 仍逐项核对读回事实，与请求矛盾的回执不能授权成功。
    if (activeTabId == null || activeTabId !== wantedId) return { ok: false, detail: `核验与请求不一致，实际活动页为 ${activeTabId ?? '未知'}` };

    if (verification.windowFocused !== true) return { ok: false, detail: '核验时目标窗口未聚焦' };

    if (verification.workingTabId !== wantedId) return { ok: false, detail: '核验时工作目标已不在该标签页' };

    return { ok: true };
  }

  if (key === 'fill') {
    const verified = receipt?.verified;

    if (verified === true) return { ok: true };

    return { ok: false, detail: verified === false ? '填写已执行，写入后读回与要求不一致' : '填写已执行，内容未核对' };
  }

  return { ok: true };
}

export function isExecutionFeedback(value: unknown): value is ExecutionFeedback {
  const v = asRecord(value);

  if (!v) return false;

  if (typeof v.id !== 'string' || v.id.length < 1 || v.id.length > 160) return false;

  if (!EXECUTION_FEEDBACK_CHANNELS.includes(v.channel as ExecutionFeedbackChannel)) return false;

  if (!EXECUTION_FEEDBACK_KINDS.includes(v.kind as ExecutionFeedbackKind)) return false;

  if (typeof v.text !== 'string' || v.text.trim().length < 1 || v.text.length > EXECUTION_FEEDBACK_TEXT_MAX) return false;

  if (typeof v.bounce !== 'boolean' || typeof v.capsuleCanCloseAction !== 'boolean') return false;

  if (!Number.isFinite(v.createdAt)) return false;

  if (v.inputId !== undefined && (typeof v.inputId !== 'string' || v.inputId.length > 160)) return false;

  if (v.runId !== undefined && v.runId !== null && typeof v.runId !== 'string') return false;

  if (v.toolCallId !== undefined && (typeof v.toolCallId !== 'string' || v.toolCallId.length > 160)) return false;
  const facts = asRecord(v.facts);

  if (!facts || typeof facts.tool !== 'string' || !['executed', 'not_executed', 'unknown'].includes(facts.executionFact as string)) return false;

  if (facts.action !== undefined && typeof facts.action !== 'string') return false;

  if (facts.tabId !== undefined && !Number.isInteger(facts.tabId)) return false;

  if (facts.detail !== undefined && (typeof facts.detail !== 'string' || facts.detail.length > EXECUTION_FEEDBACK_DETAIL_MAX)) return false;

  return true;
}
