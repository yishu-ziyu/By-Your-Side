export const TASK_RECORD_STATES = ['queued', 'running', 'waiting', 'paused', 'interrupted', 'completed', 'cancelled', 'failed'] as const;

export interface TaskRecord {
  id: string;
  originConversationId: string;
  executionConversationId: string;
  runId: string | null;
  goal: string;
  revision: number;
  controlVersion: number;
  state: typeof TASK_RECORD_STATES[number];
  updatedAt: number;
  delivery?: { id: string; text: string; revision: number };
}

const KEYS = new Set(['id', 'originConversationId', 'executionConversationId', 'runId', 'goal', 'revision', 'controlVersion', 'state', 'updatedAt', 'delivery']);
const DELIVERY_KEYS = new Set(['id', 'text', 'revision']);
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => !KEYS.has(key)) || [...KEYS].some(key => key !== 'delivery' && !Object.hasOwn(value, key))) return false;
  if (!('id' in value) || !id(value.id)
    || !('originConversationId' in value) || !id(value.originConversationId)
    || !('executionConversationId' in value) || !id(value.executionConversationId)
    || !('runId' in value) || !(value.runId === null || id(value.runId))
    || !('goal' in value) || !text(value.goal, 12000)
    || !('revision' in value) || !version(value.revision)
    || !('controlVersion' in value) || !version(value.controlVersion)
    || !('updatedAt' in value) || !version(value.updatedAt)
    || !('state' in value) || !TASK_RECORD_STATES.some(state => state === value.state)) return false;
  if (!('delivery' in value) || value.delivery === undefined) return true;
  const delivery = value.delivery;

  return !!delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    && Object.keys(delivery).length === DELIVERY_KEYS.size && Object.keys(delivery).every(key => DELIVERY_KEYS.has(key))
    && 'id' in delivery && id(delivery.id)
    && 'text' in delivery && text(delivery.text, 14000)
    && 'revision' in delivery && delivery.revision === value.revision;
}
