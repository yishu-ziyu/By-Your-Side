/**
 * `fetch` 的批量翻页：一次调用按页码取多页，每页落盘，回执保持小体积。
 * 顺序请求（不并发），每页复用单页 fetch 的守卫与上限。
 * 依据 docs/evals/20260911-fetch-pages.md。
 */
import { join } from "node:path";
import { formatFetchReply, fetchDownloadsDir, paginatedSaveName, type FetchReply } from "./fetch-result.js";

export const FETCH_PAGE_LIMIT = 20;

export interface FetchPagesRange {
  from: number;
  to: number;
  step?: number;
}

export interface FetchPagesParams {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  savePath?: string;
  pages: FetchPagesRange;
}

export interface FetchPageResult {
  page: number;
  status?: number;
  ok?: boolean;
  bytes?: number;
  path?: string;
  error?: string;
}

export interface FetchPagesReply {
  text: string;
  data: { pages: FetchPageResult[]; saved: string[]; failed: number; totalBytes: number; count: number };
}

/** 页码列表；非法范围拒绝（不发请求）。 */
export function pageNumbers(range: FetchPagesRange): number[] {
  const step = range.step ?? 1;
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || !Number.isInteger(step)) {
    throw new Error("fetch.pages 的 from/to/step 必须是整数。");
  }
  if (step < 1) throw new Error("fetch.pages.step 必须 >= 1。");
  if (range.to < range.from) throw new Error("fetch.pages 需要 from <= to。");
  const pages: number[] = [];
  for (let page = range.from; page <= range.to; page += step) pages.push(page);
  if (pages.length > FETCH_PAGE_LIMIT) {
    throw new Error(`fetch.pages 一次最多 ${FETCH_PAGE_LIMIT} 页（收到 ${pages.length} 页）。请分批调用。`);
  }
  return pages;
}

export function substitutePage(text: string, page: number): string {
  return text.split("{page}").join(String(page));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 逐页取回并落盘；单页失败只记该页，不吞掉其它页的结果。
 * 预览只给第一个成功页，避免 20 页预览把上下文撑回去。
 */
export async function fetchPages(
  params: FetchPagesParams,
  fetchOne: (request: { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }) => Promise<FetchReply>,
  dir: string = fetchDownloadsDir(),
): Promise<FetchPagesReply> {
  const pages = pageNumbers(params.pages);
  if (!params.url.includes("{page}") && !(typeof params.body === "string" && params.body.includes("{page}"))) {
    throw new Error("批量翻页需要 url 或 body 里带 {page} 占位符，例如 https://api.example.com/list?page={page}");
  }

  const results: FetchPageResult[] = [];
  const lines: string[] = [];
  const saved: string[] = [];
  let failed = 0;
  let totalBytes = 0;
  let previewed = false;
  const step = params.pages.step ?? 1;

  for (const page of pages) {
    const url = substitutePage(params.url, page);
    const body = params.body === undefined ? undefined : substitutePage(params.body, page);
    try {
      const reply = await fetchOne({ url, method: params.method, headers: params.headers, body });
      const name = paginatedSaveName(params.savePath, reply.url || url, reply.contentType, page);
      const path = join(dir, name);
      const line = formatFetchReply(reply, name, dir, !previewed);
      previewed = true;
      saved.push(path);
      totalBytes += reply.bytes;
      results.push({ page, status: reply.status, ok: reply.ok, bytes: reply.bytes, path });
      lines.push(`${page}. ${line}`);
    } catch (error) {
      failed += 1;
      results.push({ page, error: message(error) });
      lines.push(`${page}. request failed: ${message(error)}`);
    }
  }

  const succeeded = results.length - failed;
  const head = `Batch fetch ${succeeded}/${pages.length} pages (page ${params.pages.from}..${params.pages.to}${step === 1 ? "" : ` step ${step}`}); ${succeeded === 0 ? "nothing saved" : `${saved.length} file(s), ${totalBytes} bytes total on disk`}. Bodies are not in your context.`;
  const text = `${head}\n${lines.join("\n")}`;
  return { text, data: { pages: results, saved, failed, totalBytes, count: pages.length } };
}
