import type { ConversationSummary } from "../../shared/protocol.js";
import type { ReadingTranscript } from "../../shared/reading.js";
import type { TaskQueuePersistence } from "./task-queue.js";

export interface ConversationPersistence {
  load(): ConversationSummary[];
  save(summaries: ConversationSummary[]): void;
  saveReading(id: string, transcript: ReadingTranscript): void;
  readingFor?(id: string): ReadingTranscript | undefined;
  taskQueue?: TaskQueuePersistence;
}
