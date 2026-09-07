import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validConversationId, type ConversationSummary } from "../../shared/protocol.js";

/** Only native Pi message files restore model context; UI history is never prompted. */
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
    writeFileSync(`${file}.tmp`, JSON.stringify(summaries), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  sessionManager(id: string): SessionManager {
    if (!validConversationId(id)) throw new Error("Invalid conversation id");
    const directory = join(this.directory, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pointer = join(directory, "session-path.txt");
    if (existsSync(pointer)) {
      const path = readFileSync(pointer, "utf8").trim();
      if (path.startsWith(`${directory}/`) && existsSync(path)) return SessionManager.open(path);
    }
    const manager = SessionManager.create(process.cwd(), directory);
    writeFileSync(pointer, manager.getSessionFile()!, { mode: 0o600 });
    return manager;
  }
}
