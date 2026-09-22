import type { Attachment, PageContext } from './protocol.js';

export const TASK_ACTIONS = ['start', 'steer', 'status', 'pause', 'resume', 'abort'] as const;

export type TaskAction = typeof TASK_ACTIONS[number];

export interface TaskActionRequest {
  forkedFrom?: { conversationId: string; requestId: string };
  requestId: string;
  conversationId: string;
  originConversationId?:string;
  source: 'text' | 'voice';
  action: TaskAction;
  expectedRunId: string | null;
  expectedControlVersion?:number;
  scope?:'task'|'page';
  tabId?:number;
  text?: string;
  context?: PageContext;
  attachments?: Attachment[];
}

export interface TaskReceiptChange {
  /** Human label of the changed display attribute, e.g. 字体 / 显示模式. */
  attribute: string;
  /** Host-observed value before the change. */
  from: string;
  /** Host-verified value after the change (read back, not model-reported). */
  to: string;
}

/** T04: structured field-change facts for a steering receipt. Host-facts only;
 * absent whenever old/new/target/preserved cannot all be backed by observation. */
export interface TaskReceiptDiff {
  /** Label of the object the change applied to (page title). */
  target: string;
  changed: TaskReceiptChange[];
  /** Attribute labels read back as unchanged alongside the requested change. */
  preserved: string[];
}

export interface TaskReceipt {
  /** Only rejected starts explicitly eligible for a new conversation carry their original input. */
  newConversationRequest?: TaskActionRequest;
  requestId: string;
  conversationId: string;
  originConversationId?:string;
  source: 'text' | 'voice';
  action: TaskAction;
  runId: string | null;
  text: string;
  targetTitle: string;
  status: 'queued' | 'accepted' | 'applied' | 'rejected' | 'failed' | 'unknown';
  message: string;
  updatedAt: number;
  diff?: TaskReceiptDiff;
}

export const taskId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);

export function isTaskActionRequest(v: unknown): v is TaskActionRequest {
  if (!v || typeof v !== 'object') return false;
  const a = v as TaskActionRequest;

  return (a.forkedFrom === undefined || a.action === 'start' && taskId(a.forkedFrom.conversationId) && taskId(a.forkedFrom.requestId)) && taskId(a.requestId) && taskId(a.conversationId) && ['text','voice'].includes(a.source)
    && (a.originConversationId===undefined||a.source==='voice'&&taskId(a.originConversationId))
    && (a.expectedControlVersion===undefined||Number.isSafeInteger(a.expectedControlVersion)&&a.expectedControlVersion>=0)
    && TASK_ACTIONS.includes(a.action) && (a.expectedRunId === null || taskId(a.expectedRunId))
    && (a.scope===undefined||a.scope==='task'||a.scope==='page') && (a.tabId===undefined||Number.isSafeInteger(a.tabId)&&a.tabId>0)
    && (a.text === undefined || typeof a.text === 'string' && a.text.length <= 12000)
    && (!['start','steer'].includes(a.action) || typeof a.text === 'string' && !!a.text.trim() || Array.isArray(a.attachments)&&a.attachments.length>0);
}

const receiptChange = (v: unknown): v is TaskReceiptChange => !!v && typeof v === 'object'
  && typeof (v as TaskReceiptChange).attribute === 'string' && (v as TaskReceiptChange).attribute.length > 0 && (v as TaskReceiptChange).attribute.length <= 32
  && typeof (v as TaskReceiptChange).from === 'string' && (v as TaskReceiptChange).from.length > 0 && (v as TaskReceiptChange).from.length <= 64
  && typeof (v as TaskReceiptChange).to === 'string' && (v as TaskReceiptChange).to.length > 0 && (v as TaskReceiptChange).to.length <= 64;

const receiptDiff = (v: unknown): v is TaskReceiptDiff => !!v && typeof v === 'object'
  && typeof (v as TaskReceiptDiff).target === 'string' && (v as TaskReceiptDiff).target.length > 0 && (v as TaskReceiptDiff).target.length <= 120
  && Array.isArray((v as TaskReceiptDiff).changed) && (v as TaskReceiptDiff).changed.length >= 1 && (v as TaskReceiptDiff).changed.length <= 4 && (v as TaskReceiptDiff).changed.every(receiptChange)
  && Array.isArray((v as TaskReceiptDiff).preserved) && (v as TaskReceiptDiff).preserved.length <= 4 && (v as TaskReceiptDiff).preserved.every(p => typeof p === 'string' && p.length > 0 && p.length <= 32);

export function isTaskReceipt(v: unknown): v is TaskReceipt {
  if (!v || typeof v !== 'object') return false;
  const r = v as TaskReceipt;

  return (r.newConversationRequest === undefined || r.status === 'rejected' && r.action === 'start' && isTaskActionRequest(r.newConversationRequest) && r.newConversationRequest.action === 'start' && r.newConversationRequest.requestId === r.requestId && r.newConversationRequest.conversationId === r.conversationId) && taskId(r.requestId) && taskId(r.conversationId) && ['text','voice'].includes(r.source)
    && (r.originConversationId===undefined||r.source==='voice'&&taskId(r.originConversationId))
    && TASK_ACTIONS.includes(r.action) && (r.runId === null || taskId(r.runId))
    && ['queued','accepted','applied','rejected','failed','unknown'].includes(r.status)
    && typeof r.text === 'string' && r.text.length <= 12000 && typeof r.targetTitle === 'string' && r.targetTitle.length <= 120
    && typeof r.message === 'string' && r.message.length <= 14000 && Number.isFinite(r.updatedAt)
    && (r.diff === undefined || receiptDiff(r.diff));
}
