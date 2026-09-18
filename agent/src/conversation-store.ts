import { isReadingTranscript, readingHandoffContext, type ReadingTranscript } from "../../shared/reading.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validConversationId, type ConversationSummary } from "../../shared/protocol.js";

/** Restore native Pi context, or an explicit pre-first-reply reading handoff. Never prompt UI history. */
export class ConversationStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  load(): ConversationSummary[] {
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.directory, "index.json"), "utf8"));
      if (!Array.isArray(value)) return [];
      return value.filter((entry): entry is ConversationSummary => entry && validConversationId(entry.id) && typeof entry.title === "string" && typeof entry.createdAt === "number" && typeof entry.updatedAt === "number" && (entry.mode === "act" || entry.mode === "teach"))
        .map((entry) => ({ ...entry, state: "idle" })); // a restart never resumes old external actions
    } catch { return []; }
  }
  save(summaries: ConversationSummary[]): void {
    const file = join(this.directory, "index.json");
    // During extension reload, the retiring host can briefly overlap its successor.
    // A private staging file prevents either process from consuming the other's rename.
    const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staged, JSON.stringify(summaries), { mode: 0o600 });
      renameSync(staged, file);
    } finally { rmSync(staged, { force: true }); }
  }
  saveReading(id: string, transcript: ReadingTranscript): void {
    if (!validConversationId(id) || !isReadingTranscript(transcript)) throw new Error('Invalid reading handoff');
    const directory = join(this.directory, id);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const file = join(directory, 'reading.json'), staged = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(staged, JSON.stringify(transcript), {mode: 0o600}); renameSync(staged, file); }
    finally { rmSync(staged, {force: true}); }
  }
  /**
   * Pi 在首个 assistant 消息前不创建会话文件；“已接收”回执必须对应真实可恢复存储。
   * 先用 SDK 自己的 header 建文件，再 setSessionFile 接管：SDK 把该会话标为 flushed，
   * 之后的检查点、附件和阅读交接条目都会立即写盘。
   */
  private ensureSessionFile(manager: SessionManager): void {
    const file = manager.getSessionFile();
    if (!file || existsSync(file)) return;
    const header = manager.getHeader();
    if (!header) return;
    try {
      writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      // 扩展重载时新旧宿主可能短暂同时在跑：另一个进程已经建好同一份会话文件，接管它即可。
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    manager.setSessionFile(file);
  }
  sessionManager(id: string): SessionManager {
    if (!validConversationId(id)) throw new Error("Invalid conversation id");
    const directory = join(this.directory, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pointer = join(directory, "session-path.txt");
    let manager: SessionManager | undefined;
    if (existsSync(pointer)) {
      const path = readFileSync(pointer, "utf8").trim();
      if (path.startsWith(`${directory}/`) && existsSync(path)) manager = SessionManager.open(path);
    }
    if (!manager) {
      manager = SessionManager.create(process.cwd(), directory);
      this.ensureSessionFile(manager);
      writeFileSync(pointer, manager.getSessionFile()!, { mode: 0o600 });
    }
    // Pi defers its first file until an assistant message exists. Reading transfer
    // deliberately triggers no model turn, so restore its explicit seed separately.
    const readingFile = join(directory, 'reading.json');
    if (existsSync(readingFile)) {
      const reading: unknown = JSON.parse(readFileSync(readingFile, 'utf8'));
      if (!isReadingTranscript(reading)) throw new Error('Invalid stored reading handoff');
      const already = manager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'reading-handoff');
      if (!already) manager.appendCustomMessageEntry('reading-handoff', readingHandoffContext(reading), false);
    }
    return manager;
  }
}
