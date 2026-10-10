import type { ReadingTranscript } from '../../../shared/reading.js';

export interface ReadingRecord extends ReadingTranscript {
  documentKey: string;
  modelConversationId: string;
  requestId?: string;
  handoffRequestId?: string;
  handoffError?: string;
  transferredConversationId?: string;
  /** 改口发出的轮次（下标）：这一轮带「已改口」，它前面被停下的一轮折叠。 */
  correctedTurns?: number[];
  updatedAt: number;
}

export const readingBusy = (record?: ReadingTranscript): boolean => ['pending', 'streaming'].includes(record?.turns.at(-1)?.state ?? '');
