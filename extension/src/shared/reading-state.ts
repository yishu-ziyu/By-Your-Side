import type { ReadingTranscript } from '../../../shared/reading.js';

export interface ReadingRecord extends ReadingTranscript {
  documentKey: string;
  modelConversationId: string;
  requestId?: string;
  handoffRequestId?: string;
  handoffError?: string;
  transferredConversationId?: string;
  /** 这张卡交给助手做事用的会话：一张卡一个，转侧栏时就转到它。 */
  agentConversationId?: string;
  /** 正在为这张卡开助手会话的请求。 */
  agentRequestId?: string;
  /** 助手会话已经看过的轮数（下标）：之后只补交它没看过的问答。 */
  agentSynced?: number;
  /** 改口发出的轮次（下标）：这一轮带「已按新问题重答」，它前面被停下的一轮折叠。 */
  correctedTurns?: number[];
  /** 按下说话时停下的那一轮（下标）：接着说出的新要求按改口接在它后面。 */
  interruptedTurn?: number;
  updatedAt: number;
}

export const readingBusy = (record?: ReadingTranscript): boolean => ['pending', 'streaming'].includes(record?.turns.at(-1)?.state ?? '');
