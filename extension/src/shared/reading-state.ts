import type { ReadingTranscript } from '../../../shared/reading.js';

export interface ReadingRecord extends ReadingTranscript {
  documentKey: string;
  modelConversationId: string;
  requestId?: string;
  handoffRequestId?: string;
  handoffError?: string;
  transferredConversationId?: string;
  /** 改口发出的轮次（下标）：这一轮带「已按新问题重答」，它前面被停下的一轮折叠。 */
  correctedTurns?: number[];
  /** 按下说话时停下的那一轮（下标）：接着说出的新要求按改口接在它后面。 */
  interruptedTurn?: number;
  updatedAt: number;
}

export const readingBusy = (record?: ReadingTranscript): boolean => ['pending', 'streaming'].includes(record?.turns.at(-1)?.state ?? '');
