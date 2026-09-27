import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentPersistence } from "./document-persistence.js";

const LOCK_WAIT_MS = 10_000;

const STALE_LOCK_MS = 30_000;

/** 本机宿主：一个目录里的一个 JSON 文件；跨进程用目录锁，写入先写临时文件再改名。 */
export class FileDocument implements DocumentPersistence {
  private readonly file: string;
  private readonly lockDirectory: string;

  constructor(private readonly directory: string, private readonly fileName: string) {
    if (directory.trim().length === 0) throw new Error("Memory directory is required");
    this.file = join(directory, fileName);
    this.lockDirectory = join(directory, `.${fileName.replace(/\.json$/, "")}.lock`);
  }

  async read(): Promise<string | null> {
    try {
      return await readFile(this.file, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    await access(this.directory, constants.R_OK | constants.W_OK);
    const release = await acquireDirectoryLock(this.lockDirectory);

    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async write(text: string, commitGuard?: () => boolean): Promise<void> {
    const temporary = join(this.directory, `.${this.fileName}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);

    try {
      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    await handle.close();

    try {
      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

async function acquireDirectoryLock(directory: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  let delay = 4;

  for (;;) {
    try {
      await mkdir(directory);

      return async () => { await rm(directory, { recursive: true, force: true }); };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;

      try {
        const info = await stat(directory);

        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(directory, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (isCode(statError, "ENOENT")) continue;
        throw statError;
      }

      if (Date.now() - startedAt >= LOCK_WAIT_MS) throw new Error("Timed out waiting for the memory store lock");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 64);
    }
  }
}

function isCode(error: unknown, code: string): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
