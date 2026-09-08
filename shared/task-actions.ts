import type { Attachment, PageContext } from './protocol.js';

export const TASK_ACTIONS = ['start', 'steer', 'status', 'pause', 'resume', 'abort'] as const;
export type TaskAction = typeof TASK_ACTIONS[number];
export interface TaskActionRequest {
  requestId: string;
  conversationId: string;
  originConversationId?:string;
  source: 'text' | 'voice';
  action: TaskAction;
  expectedRunId: string | null;
  scope?:'task'|'page';
  tabId?:number;
  text?: string;
  context?: PageContext;
  attachments?: Attachment[];
}
export interface TaskReceipt {
  requestId: string;
  conversationId: string;
  originConversationId?:string;
  source: 'text' | 'voice';
  action: TaskAction;
  runId: string | null;
  text: string;
  targetTitle: string;
  status: 'accepted' | 'applied' | 'rejected' | 'failed' | 'unknown';
  message: string;
  updatedAt: number;
}
export const taskId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
export function isTaskActionRequest(v: unknown): v is TaskActionRequest {
  if (!v || typeof v !== 'object') return false;
  const a = v as TaskActionRequest;
  return taskId(a.requestId) && taskId(a.conversationId) && ['text','voice'].includes(a.source)
    && (a.originConversationId===undefined||a.source==='voice'&&taskId(a.originConversationId))
    && TASK_ACTIONS.includes(a.action) && (a.expectedRunId === null || taskId(a.expectedRunId))
    && (a.scope===undefined||a.scope==='task'||a.scope==='page') && (a.tabId===undefined||Number.isSafeInteger(a.tabId)&&a.tabId>0)
    && (a.text === undefined || typeof a.text === 'string' && a.text.length <= 12000)
    && (!['start','steer'].includes(a.action) || typeof a.text === 'string' && !!a.text.trim() || Array.isArray(a.attachments)&&a.attachments.length>0);
}
export function isTaskReceipt(v: unknown): v is TaskReceipt {
  if (!v || typeof v !== 'object') return false;
  const r = v as TaskReceipt;
  return taskId(r.requestId) && taskId(r.conversationId) && ['text','voice'].includes(r.source)
    && (r.originConversationId===undefined||r.source==='voice'&&taskId(r.originConversationId))
    && TASK_ACTIONS.includes(r.action) && (r.runId === null || taskId(r.runId))
    && ['accepted','applied','rejected','failed','unknown'].includes(r.status)
    && typeof r.text === 'string' && r.text.length <= 12000 && typeof r.targetTitle === 'string' && r.targetTitle.length <= 120
    && typeof r.message === 'string' && r.message.length <= 14000 && Number.isFinite(r.updatedAt);
}
