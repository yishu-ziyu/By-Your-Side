/** 扩展宿主使用的公开入口；浏览器构建会替换 Node 专属模块。 */
export { startHostCore } from "./host-core.js";

export type { HostCore, HostCoreOptions, ClientConn } from "./host-core.js";

export type { ConversationPersistence } from "./conversation-persistence.js";

export { createConversationRuntime } from "./conversation-runtime.js";

export { RealtimeVoiceSession } from "./realtime-voice-session.js";

export { MODEL as REALTIME_VOICE_MODEL } from "./realtime-voice-connection.js";

export { MemoryStore } from "./memory-store.js";

export { usePendingMemoryJudgments } from "./memory-runtime.js";

export { InProcessLock, type DocumentPersistence } from "./document-persistence.js";

export { TaskHistoryStore } from "./task-history.js";

export type { ArtifactPersistence } from "./artifacts-tool.js";

export { SessionLog, type SessionLogPort } from "./session-log.js";
