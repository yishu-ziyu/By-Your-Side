export const CONTINUATION_KEY = 'continuousDelegation';
export const PROGRAM_OBSERVATION_KEY = 'programObservation';

export const CONTINUATION_STATES = ['RUNNING', 'WAITING_CONDITION', 'WAITING_USER', 'SUSPENDED', 'VERIFYING', 'COMPLETED', 'STOPPED', 'FAILED'] as const;

export interface WaitCondition {
  target: string;
  property: 'exists' | 'text' | 'value' | 'enabled' | 'checked' | 'visible';
  operator: 'equals' | 'contains' | 'changed';
  expected?: string | boolean;
  goalItem: string;
  description: string;
}

export interface TaskContinuation {
  schema: 1;
  id: string;
  goalVersion: number;
  controlVersion: number;
  state: typeof CONTINUATION_STATES[number];
  mode: 'once' | 'watch';
  tabId: number;
  url: string;
  documentId: string;
  condition: WaitCondition;
  expiresAt: number;
  createdAt: number;
  observations: number;
  maxObservations: number;
  activeMs: number;
  maxActiveMs: number;
  modelCalls: number;
  maxModelCalls: number;
  pollMs: number;
  baseline: string | null;
  observedVersion: string | null;
  processingVersion: string | null;
  processedVersion: string | null;
  pendingVersion: string | null;
  requestId: string | null;
  segmentStartedAt: number | null;
  stopReason?: string;
  lastError?: string;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown): value is number => counter(value) && value > 0;
const nullableId = (value: unknown) => value === null || boundedText(value, 512);
const nullableVersion = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const conditionKeys = new Set(['target', 'property', 'operator', 'expected', 'goalItem', 'description']);
const continuationKeys = new Set(['schema', 'id', 'goalVersion', 'controlVersion', 'state', 'mode', 'tabId', 'url', 'documentId', 'condition', 'expiresAt', 'createdAt', 'observations', 'maxObservations', 'activeMs', 'maxActiveMs', 'modelCalls', 'maxModelCalls', 'pollMs', 'baseline', 'observedVersion', 'processingVersion', 'processedVersion', 'pendingVersion', 'requestId', 'segmentStartedAt', 'stopReason', 'lastError']);

export function isWaitCondition(value: unknown): value is WaitCondition {
  if (!object(value) || !boundedText(value.target, 1000) || !boundedText(value.goalItem, 160) || !boundedText(value.description, 240)) return false;
  if (Object.keys(value).some(key => !conditionKeys.has(key))) return false;
  const selector = value.target.startsWith('loc=css:') ? value.target.slice(8).trim() : value.target.trim();

  // Persistent conditions cannot reuse snapshot references or an executable locator language.
  if (!selector || selector.startsWith('@') || /^(?:loc=|(?:javascript|xpath|text|role|href):)/i.test(selector) || /[\u0000-\u001f]/.test(selector)) return false;
  if (value.operator === 'changed' && /^(?:body|html|:root|\*)$/i.test(selector)) return false;
  if (typeof value.property !== 'string' || !['exists', 'text', 'value', 'enabled', 'checked', 'visible'].includes(value.property)
    || typeof value.operator !== 'string' || !['equals', 'contains', 'changed'].includes(value.operator)) return false;
  const textProperty = value.property === 'text' || value.property === 'value';

  if (value.operator === 'contains' && !textProperty) return false;
  if (value.expected !== undefined && !(textProperty ? typeof value.expected === 'string' && value.expected.length <= 4000 : typeof value.expected === 'boolean')) return false;
  if (value.operator === 'contains' && value.expected === '') return false;

  return value.operator === 'changed' || value.expected !== undefined;
}

export function isTaskContinuation(value: unknown): value is TaskContinuation {
  if (!object(value) || value.schema !== 1 || !boundedText(value.id, 160) || !positive(value.goalVersion) || !counter(value.controlVersion)) return false;
  if (Object.keys(value).some(key => !continuationKeys.has(key))) return false;
  if (!CONTINUATION_STATES.includes(value.state as TaskContinuation['state']) || value.mode !== 'once' && value.mode !== 'watch') return false;
  if (!positive(value.tabId) || !boundedText(value.documentId, 256) || !boundedText(value.url, 8192) || !isWaitCondition(value.condition)) return false;

  try {
    const url = new URL(value.url);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  } catch { return false; }

  return counter(value.createdAt) && positive(value.expiresAt) && value.expiresAt > value.createdAt
    && counter(value.observations) && positive(value.maxObservations) && value.maxObservations <= 100_000
    && counter(value.activeMs) && positive(value.maxActiveMs) && value.maxActiveMs <= 86_400_000
    && counter(value.modelCalls) && positive(value.maxModelCalls) && value.maxModelCalls <= 100_000
    && counter(value.pollMs) && value.pollMs >= 1000 && value.pollMs <= 60_000
    && (value.baseline === null || typeof value.baseline === 'string' && value.baseline.length <= 4000)
    && nullableVersion(value.observedVersion) && nullableVersion(value.processingVersion) && nullableVersion(value.processedVersion) && nullableVersion(value.pendingVersion) && nullableId(value.requestId)
    && (value.segmentStartedAt === null || counter(value.segmentStartedAt))
    && (value.stopReason === undefined || boundedText(value.stopReason, 240))
    && (value.lastError === undefined || boundedText(value.lastError, 600));
}
