import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.SIDEAGENT_DATA_DIR?.trim() || join(homedir(), ".sideagent");
}

