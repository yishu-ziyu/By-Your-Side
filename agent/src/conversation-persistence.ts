import type { ConversationSummary } from "../../shared/protocol.js";
import type { ReadingTranscript } from "../../shared/reading.js";

/**
 * 会话目录的持久化接口：本机伴随进程写文件（conversation-store.ts），扩展内 agent 写 IndexedDB。
 * 宿主重启后按 load() 重建会话，侧栏手里的会话编号仍然有效。
 */
export interface ConversationPersistence {
  load(): ConversationSummary[];
  save(summaries: ConversationSummary[]): void;
  saveReading(id: string, transcript: ReadingTranscript): void;
  /**
   * 模型上下文不随存储恢复的宿主才提供：恢复会话时把阅读交接重新交给会话。
   * 本机由 sessionManager 从 reading.json 播种，不提供，避免交接内容重复。
   */
  readingFor?(id: string): ReadingTranscript | undefined;
}
