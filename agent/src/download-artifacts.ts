/**
 * CAP-02A：宿主侧下载制品 — 等 Chrome 报完成后 saveAs。
 * 扩展只负责事件归属与 chrome.downloads 状态；文件 I/O 在伴随进程。
 * 不将 fetch(GET) 冒充为页面下载。
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export type DownloadStatLike = {
  downloadId: string;
  tabId: number;
  url: string;
  suggestedFilename: string;
  path: string | null;
  failure: string | null;
  completed: boolean;
  cancelled: boolean;
  bytes?: number;
  danger?: string;
};

export function assertAbsoluteSavePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("INVALID_ARGUMENT: download.saveAs requires an absolute file path");
  }

  if (path.includes("..")) {
    throw new Error("INVALID_ARGUMENT: download.saveAs path must not contain ..");
  }
}

/** 只认 Chrome 报完成的记录；中断、取消、超时都如实报错。 */
export async function waitForDownloadFile(
  stat: DownloadStatLike,
  timeoutMs: number,
  poll: () => Promise<DownloadStatLike>,
): Promise<{ path: string; stat: DownloadStatLike }> {
  const started = Date.now();
  let current = stat;

  while (Date.now() - started < timeoutMs) {
    if (current.cancelled) throw new Error("download failed: canceled");

    if (current.failure) throw new Error(`download failed: ${current.failure}`);

    if (current.completed && current.path) return { path: current.path, stat: current };
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
