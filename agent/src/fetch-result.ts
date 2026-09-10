/**
 * `fetch` 回执的落盘与格式化（伴随进程侧）。
 * 大响应不进上下文：写进 ~/.sideagent/downloads/，回执行只给路径、字节数与预览。
 * 依据 docs/evals/20260911-fetch-tool.md。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";

/** 小于这个长度直接内联给模型；超过则落盘只给预览。 */
export const FETCH_INLINE_LIMIT = 4_000;
export const FETCH_PREVIEW_CHARS = 300;

export interface FetchReply {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

export function fetchDownloadsDir(): string {
  // 隔离/测试可指向临时目录；生产默认仍是 ~/.sideagent/downloads。
  return process.env.SIDEAGENT_DOWNLOADS_DIR?.trim() || join(homedir(), ".sideagent", "downloads");
}

function extensionFor(contentType: string): string {
  if (/json/i.test(contentType)) return ".json";
  if (/html/i.test(contentType)) return ".html";
  if (/csv/i.test(contentType)) return ".csv";
  if (/text\/plain/i.test(contentType)) return ".txt";
  if (/xml/i.test(contentType)) return ".xml";
  return ".bin";
}

/** savePath 只允许落在 downloads 目录内的文件名；其它形式一律改成生成名。 */
export function safeDownloadName(savePath: string | undefined, url: string, contentType: string): string {
  const fallback = `${Date.now().toString(36)}-${basename(new URL(url).pathname || "response").replace(/[^\w.-]+/g, "_").slice(0, 60) || "response"}`;
  const raw = (savePath ?? "").trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    // 只当文件名的输入：去掉任何目录成分，拿不到就退回生成名。
    const clean = raw ? basename(raw).replace(/[^\w.-]+/g, "_") : "";
    const withExt = clean && clean !== "." && clean !== ".." ? clean : fallback;
    return extname(withExt) ? withExt : `${withExt}${extensionFor(contentType)}`;
  }
  return extname(raw) ? raw : `${raw}${extensionFor(contentType)}`;
}

export function saveFetchBody(reply: FetchReply, savePath?: string, dir: string = fetchDownloadsDir()): { path: string; bytes: number } {
  const name = safeDownloadName(savePath, reply.url, reply.contentType);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, reply.text, { mode: 0o600 });
  return { path, bytes: Buffer.byteLength(reply.text) };
}

/** 批量翻页的文件名：基础名 + `-p<page>` + 扩展名；基础名沿用 savePath 或从 URL 生成。 */
export function paginatedSaveName(savePath: string | undefined, url: string, contentType: string, page: number): string {
  const base = savePath?.trim() ? safeDownloadName(savePath, url, contentType) : safeDownloadName(undefined, url, contentType);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}-p${page}${ext}`;
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > FETCH_PREVIEW_CHARS ? `${oneLine.slice(0, FETCH_PREVIEW_CHARS)}…` : oneLine;
}

/** 模型可见回执：状态行 + 内容或落盘摘要。内容一律过不可信边界与凭据隐去。 */
export function formatFetchReply(reply: FetchReply, savePath?: string, dir: string = fetchDownloadsDir(), includePreview = true): string {
  const head = `HTTP ${reply.status}${reply.ok ? "" : " (not ok)"} ${reply.contentType || "unknown content-type"}; ${reply.bytes} bytes${reply.truncated ? " (truncated at the extension cap; the rest was not read)" : ""}.`;
  const wantFile = savePath !== undefined || reply.text.length > FETCH_INLINE_LIMIT;
  if (wantFile) {
    const saved = saveFetchBody(reply, savePath, dir);
    const shown = saved.path.startsWith(homedir()) ? `~${saved.path.slice(homedir().length)}` : saved.path;
    const tail = includePreview ? ` Preview: ${preview(redactCredentialText(reply.text))}` : "";
    return `${head} Saved to ${shown} (${saved.bytes} bytes on disk); the body is not in your context.${tail}`;
  }
  const body = reply.text.trim();
  if (!body) return `${head} Empty body.`;
  return `${head}\n${wrapPageContent(redactCredentialText(body), { url: reply.url })}`;
}
