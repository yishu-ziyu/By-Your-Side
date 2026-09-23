/**
 * CAP-02A：宿主侧下载制品 — 轮询临时目录、saveAs、删除。
 * 扩展只负责 Page.setDownloadBehavior + CDP 事件；文件 I/O 在伴随进程。
 * 不将 fetch(GET) 冒充为页面下载。
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fetchDownloadsDir } from "./fetch-result.js";

export type DownloadStatLike = {
  downloadId: string;
  tabId: number;
  url: string;
  suggestedFilename: string;
  path: string | null;
  failure: string | null;
  completed: boolean;
  cancelled: boolean;
  downloadPath?: string;
  expectedPath?: string;
};

function findDownloadedFile(directory: string): string | undefined {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && !e.name.endsWith(".crdownload"));
    if (files.length > 1) {
      throw new Error(`download completed with ${files.length} files in its temporary directory`);
    }
    return files.length === 1 ? join(directory, files[0]!.name) : undefined;
  } catch (error) {
    if (error instanceof Error && /download completed with/.test(error.message)) throw error;
    return undefined;
  }
}

export function createDownloadArmDir(tokenHint = "arm"): string {
  const root = join(fetchDownloadsDir(), "cap02a");
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${tokenHint}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function assertAbsoluteSavePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("INVALID_ARGUMENT: download.saveAs requires an absolute file path");
  }
  if (path.includes("..")) {
    throw new Error("INVALID_ARGUMENT: download.saveAs path must not contain ..");
  }
}

export async function waitForDownloadFile(
  stat: DownloadStatLike,
  timeoutMs: number,
  poll: () => Promise<DownloadStatLike>,
): Promise<{ path: string; stat: DownloadStatLike }> {
  const started = Date.now();
  let current = stat;
  while (Date.now() - started < timeoutMs) {
    if (current.failure) throw new Error(`download failed: ${current.failure}`);
    if (current.cancelled) throw new Error("download failed: canceled");
    const dir = current.downloadPath;
    if (dir) {
      const found = findDownloadedFile(dir);
      if (found) return { path: found, stat: current };
    }
    if (current.path) return { path: current.path, stat: current };
    await new Promise((r) => setTimeout(r, 50));
    current = await poll();
  }
  throw new Error(`download did not complete within ${timeoutMs}ms`);
}

export async function hostDownloadSaveAs(input: {
  downloadId: string;
  path: string;
  timeoutMs?: number;
  stat: () => Promise<DownloadStatLike>;
}): Promise<{ saved: true; path: string; bytes: number; suggestedFilename: string; url: string; tabId: number }> {
  assertAbsoluteSavePath(input.path);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 1), 120_000);
  const initial = await input.stat();
  const { path: source, stat } = await waitForDownloadFile(initial, timeoutMs, input.stat);
  mkdirSync(dirname(input.path), { recursive: true });
  copyFileSync(source, input.path);
  const bytes = statSync(input.path).size;
  return {
    saved: true,
    path: input.path,
    bytes,
    suggestedFilename: stat.suggestedFilename,
    url: stat.url,
    tabId: stat.tabId,
  };
}

export function hostDownloadDeleteTemp(downloadPath: string | undefined): void {
  if (!downloadPath || !downloadPath.startsWith(fetchDownloadsDir())) return;
  try {
    rmSync(downloadPath, { recursive: true, force: true });
  } catch {
    /* 已清理 */
  }
}
