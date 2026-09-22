import type { ReadingTranscript } from '../../../shared/reading.js';

export interface ReadingRecord extends ReadingTranscript {
  documentKey: string;
  modelConversationId: string;
  requestId?: string;
  handoffRequestId?: string;
  handoffError?: string;
  transferredConversationId?: string;
  updatedAt: number;
}

export const readingBusy = (record?: ReadingTranscript): boolean => ['pending', 'streaming'].includes(record?.turns.at(-1)?.state ?? '');
