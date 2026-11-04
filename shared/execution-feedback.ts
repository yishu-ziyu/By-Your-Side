import type { ToolExecutionFact } from './protocol.js';

const EXECUTION_FEEDBACK_CHANNELS = ['capsule', 'voice', 'none'] as const;

export type ExecutionFeedbackChannel = (typeof EXECUTION_FEEDBACK_CHANNELS)[number];

const EXECUTION_FEEDBACK_KINDS = ['success', 'pending', 'unknown', 'failure'] as const;

export type ExecutionFeedbackKind = (typeof EXECUTION_FEEDBACK_KINDS)[number];

const EXECUTION_FEEDBACK_TEXT_MAX = 60;

const EXECUTION_FEEDBACK_DETAIL_MAX = 120;

const CAPSULE_SUCCESS: Record<string, string> = {
  'tabs:switch': '切好了',
  'fill': '已填入',
};

const CAPSULE_CLOSE_ON_SUCCESS = new Set(['tabs:switch']);

export interface ExecutionFeedbackFacts {
  tool: string;
  action?: string;
  executionFact: ToolExecutionFact;
  tabId?: number;
  detail?: string;
}

export interface ExecutionFeedback {
  id: string;
  channel: ExecutionFeedbackChannel;
  kind: ExecutionFeedbackKind;
  text: string;
  bounce: boolean;
  capsuleCanCloseAction: boolean;
  facts: ExecutionFeedbackFacts;
  inputId?: string;
  runId?: string | null;
  toolCallId?: string;
  createdAt: number;
}

interface ExecutionFeedbackInput {
  tool: string;
  args?: Record<string, unknown>;
  executionFact: ToolExecutionFact;
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

function executionFeedbackKey(tool: string, args?: Record<string, unknown>): string {
  const action = asRecord(args ?? null)?.action;

  return typeof action === 'string' && action ? `${tool}:${action}` : tool;
}

export function classifyDirectExecutionFeedback(input: ExecutionFeedbackInput): ExecutionFeedback | null {
  const key = executionFeedbackKey(input.tool, input.args);
  const successText = CAPSULE_SUCCESS[key];

  if (!successText) return null;
  const identity = input.toolCallId ? `tool:${input.toolCallId}` : input.inputId ? `input:${input.inputId}` : null;

  if (!identity) return null;
  const action = asRecord(input.args ?? null)?.action;
  const receipt = asRecord(input.data);
  const tabId = typeof receipt?.tabId === 'number' && Number.isInteger(receipt.tabId) ? receipt.tabId : undefined;

  const facts: ExecutionFeedbackFacts = {
    tool: input.tool,
    executionFact: input.executionFact,
  };

  if (typeof action === 'string' && action) facts.action = action;

  if (tabId != null) facts.tabId = tabId;

  const base: Omit<ExecutionFeedback, 'channel' | 'kind' | 'text' | 'bounce' | 'capsuleCanCloseAction'> = {
    id: identity,
    facts,
    runId: input.runId ?? null,
    createdAt: input.at ?? Date.now(),
  };

  if (input.inputId) base.inputId = input.inputId;

  if (input.toolCallId) base.toolCallId = input.toolCallId;

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

  if (input.failed) {
    return { ...base, channel: 'capsule', kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false };
  }

  const gate = successEvidence(key, input.args, receipt);

  if (!gate.ok) {
    const gatedFacts: ExecutionFeedbackFacts = { ...base.facts };

    if (gate.detail) gatedFacts.detail = gate.detail;

    return {
      ...base,
      channel: 'capsule',
      kind: 'unknown',
      text: '结果待确认',
      bounce: false,
      capsuleCanCloseAction: false,
      facts: gatedFacts,
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

function successEvidence(key: string, args: Record<string, unknown> | undefined, receipt: Record<string, unknown> | null): { ok: boolean; detail?: string } {
  if (key === 'tabs:switch') {
    const wanted = asRecord(args ?? null)?.tabId;
    const wantedId = typeof wanted === 'number' && Number.isInteger(wanted) ? wanted : null;
    const actual = receipt?.tabId;

    if (typeof actual !== 'number' || !Number.isInteger(actual)) return { ok: false, detail: '工具结果没有给出切换后的标签页' };

    if (wantedId != null && actual !== wantedId) {
      return { ok: false, detail: `要求切到标签 ${wantedId}，工具结果指向 ${actual}` };
    }

    if (wantedId == null) return { ok: false, detail: '请求没有给出目标标签，无法核验' };
    const verification = asRecord(receipt?.verification);

    if (!verification) return { ok: false, detail: '工具结果未附执行后读回，实际活动页未核验' };
    const activeTabId = typeof verification.activeTabId === 'number' && Number.isInteger(verification.activeTabId) ? verification.activeTabId : null;

    if (verification.verified !== true) {
      if (activeTabId != null && activeTabId !== wantedId) return { ok: false, detail: `核验时目标页不是活动页，实际活动页为 ${activeTabId}` };

      if (activeTabId != null && verification.windowFocused !== true) return { ok: false, detail: '核验时目标窗口未聚焦，用户当前看不到该页' };

      return { ok: false, detail: '执行后读回失败，未能核验实际活动页' };
    }

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
