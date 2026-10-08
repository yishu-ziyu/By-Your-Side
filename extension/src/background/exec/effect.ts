/**
 * 动作效果证据的后台接线：注入 content-effect.js、取基线、早停收集、清理。
 * 效果证据失败（页面禁止注入、导航换文档、SW 重启）绝不能拖垮动作本身：
 * 所有入口都吞掉异常并返回 undefined，让调用方按「没有证据」处理。
 */
import { EMPTY_EFFECT_REPORT, downloadEvidence, requestEvidence, settleEffectReport, type EffectDownload, type EffectReport } from "../../../../shared/effect.js";
import { networkRingFor } from "../network-log.js";

const CONTENT_FILE = "content-effect.js";

/** 每个效果会话的开始时刻：点击窗口的起点，用来认出这次点击后页面发出的请求。 */
const effectStarts = new Map<string, number>();

interface EffectInput {
  token: string;
  point?: [number, number];
  selector?: string;
}

async function callPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const results = await chrome.scripting.executeScript<Args, Result>({ target: { tabId }, world: "ISOLATED", func, args });
  const first = results[0];

  if (!first) throw new Error("页面脚本未返回结果");

  return first.result as Awaited<Result>;
}

export async function ensureEffectScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE], world: "ISOLATED" });
}

/** 动作前取基线；返回 token，失败返回 null（调用方跳过效果证据）。 */
export async function beginEffect(
  tabId: number,
  input: { point?: [number, number]; selector?: string } = {},
): Promise<string | null> {
  const token = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    await ensureEffectScript(tabId);
    const payload: EffectInput = { token, ...input };

    // 必须拿到页面侧确认才算基线成立：脚本未注入/版本不符时不能给 token，
    // 否则后面的轮询会空转到超时，把「没采集」当成「没变化」。
    const ack = await callPage<[EffectInput], Promise<{ ok?: boolean } | undefined> | { ok?: boolean } | undefined>(
      tabId,
      (i: EffectInput) => window.__sideagent?.effect?.begin(i),
      [payload],
    );

    if (!ack?.ok) return null;

    if (effectStarts.size > 50) effectStarts.delete(effectStarts.keys().next().value!);
    effectStarts.set(token, startedAt);

    return token;
  } catch {
    return null;
  }
}

/** 动作后收集：有强证据立即返回，否则等到超时；拿不到任何读数返回 undefined。 */
export async function collectEffect(tabId: number, token: string | null): Promise<EffectReport | undefined> {
  if (!token) return undefined;

  try {
    const report = await settleEffectReport(async () => {
      try {
        return await callPage(tabId, (t: string) => window.__sideagent?.effect?.diff?.(t) ?? null, [token]);
      } catch {
        return null;
      }
    });

    const since = effectStarts.get(token);
    const pageUrl = since === undefined ? "" : await chrome.tabs.get(tabId).then(tab => tab.url ?? "", () => "");
    const sent = since === undefined ? [] : [
      ...requestEvidence(networkRingFor(tabId)?.entries ?? [], since, Date.now(), pageUrl),
      ...downloadEvidence(await clickDownloads(tabId, since).catch(() => []), pageUrl),
    ];

    if (!sent.length) return report;
    const base = report ?? EMPTY_EFFECT_REPORT;

    return { ...base, changed: true, evidence: [...base.evidence, ...sent] };
  } finally {
    effectStarts.delete(token);

    try {
      await callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]);
    } catch {
      /* 页面已经换了文档，会话自然消失 */
    }
  }
}

/** 点击后最多等多久：下载要先等跳转的响应头才出现，出现后再等 Chrome 报完成。 */
const DOWNLOAD_WAIT_MS = 3000;

/**
 * 处理这次点击期间开始的下载。只在两种情况下等（最多 DOWNLOAD_WAIT_MS）：
 * 同网站的下载还没报完成；或点击引起的文档跳转还没结束、或被中止（跳转变成下载时 CDP 报 ERR_ABORTED）。
 * 普通跳转一加载完、普通点击没有下载，都只查一次就返回，不拖慢点击。拿不到下载记录时返回空，不影响点击本身。
 */
async function clickDownloads(tabId: number, since: number): Promise<EffectDownload[]> {
  if (!chrome.downloads?.search) return [];
  const startedAfter = new Date(since - 50).toISOString();
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  let items: chrome.downloads.DownloadItem[] = [];

  for (;;) {
    items = await Promise.resolve(chrome.downloads.search({ startedAfter })).catch(() => []);
    const pendingDownload = items.some(i => i.state === "in_progress");
    const docs = (networkRingFor(tabId)?.entries ?? []).filter(e => e.startedAt >= since && e.resourceType === "document");
    const mayBecomeDownload = items.length === 0 && docs.some(e => e.failed !== undefined || e.canceled || e.endedTs === undefined);

    if ((!pendingDownload && !mayBecomeDownload) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  return items.map(i => {
    const base = i.filename.split(/[\\/]/).pop() || (() => {
      try {
        return decodeURIComponent(new URL(i.finalUrl || i.url).pathname.split("/").pop() ?? "");
      } catch {
        return "";
      }
    })();

    return {
      url: i.finalUrl || i.url,
      referrer: i.referrer ?? "",
      filename: base || "(no name yet)",
      path: i.filename,
      // SAFETY: chrome.downloads.State 只有这三个值。
      state: i.state as EffectDownload["state"],
      bytes: i.state === "complete" ? (i.fileSize >= 0 ? i.fileSize : i.bytesReceived) : undefined,
      error: i.error,
      danger: i.danger && i.danger !== "safe" && i.danger !== "accepted" ? i.danger : undefined,
    };
  });
}
