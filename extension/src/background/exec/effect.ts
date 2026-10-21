/**
 * 动作效果证据的后台接线：注入 content-effect.js、取基线、早停收集、清理。
 * 效果证据失败（页面禁止注入、导航换文档、SW 重启）绝不能拖垮动作本身：
 * 所有入口都吞掉异常并返回 undefined，让调用方按「没有证据」处理。
 */
import { EMPTY_EFFECT_REPORT, downloadEvidence, pendingRequests, requestEvidence, settleEffectReport, type EffectDownload, type EffectReport, type PageAppeared } from "../../../../shared/effect.js";
import { undoScrubber } from "../fill-undo.js";
import { networkRingFor } from "../network-log.js";
import { withTimeout } from "../timeout.js";
import { hasPageBaseline } from "../page-changes.js";
import { readPageChanges } from "./snapshot.js";
import { isOwnBackupDownload } from "../../shared/memory-backup.js";

const CONTENT_FILE = "content-effect.js";

/** 报告 → 动作期间页面上变过的几处（定位串，只在后台用，不进回执）。 */
const changedRoots = new WeakMap<EffectReport, { roots: Array<{ sel: string; field?: true }> | "many"; since: number }>();

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

async function ensureEffectScript(tabId: number): Promise<void> {
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

/** 动作后收集：有强证据、且动作后发出的同网站请求都已完成就返回，否则等到超时；拿不到任何读数返回 undefined。 */
export async function collectEffect(tabId: number, token: string | null): Promise<EffectReport | undefined> {
  if (!token) return undefined;

  try {
    const since = effectStarts.get(token);
    const startUrl = since === undefined ? "" : await chrome.tabs.get(tabId).then(tab => tab.url ?? "", () => "");

    const settled = await settleEffectReport(async () => {
      try {
        return await callPage(tabId, (t: string) => window.__sideagent?.effect?.diff?.(t) ?? null, [token]);
      } catch {
        return null;
      }
    }, { pending: () => since === undefined ? 0 : pendingRequests(networkRingFor(tabId)?.entries ?? [], since, startUrl) });

    const pageUrl = since === undefined ? "" : await chrome.tabs.get(tabId).then(tab => tab.url ?? "", () => "");
    const report = await withDocumentChange(tabId, token, settled, startUrl, pageUrl);

    // 读变过的几处也算“为此多花的时间”：从这里开始计时。
    const rootsAt = Date.now();
    const roots = await callPage(tabId, (t: string) => window.__sideagent?.effect?.roots?.(t) ?? null, [token]).catch(() => null);
    const sent = since === undefined ? [] : [
      ...requestEvidence(networkRingFor(tabId)?.entries ?? [], since, Date.now(), pageUrl),
      ...downloadEvidence(await clickDownloads(tabId, since).catch(() => []), pageUrl),
    ];

    const final = !sent.length ? report : { ...(report ?? EMPTY_EFFECT_REPORT), changed: true, evidence: [...(report ?? EMPTY_EFFECT_REPORT).evidence, ...sent] };

    if (final && roots) changedRoots.set(final, { roots, since: rootsAt });

    return final;
  } finally {
    effectStarts.delete(token);

    try {
      await callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]);
    } catch {
      /* 页面已经换了文档，会话自然消失 */
    }
  }
}

const withoutHash = (url: string) => url.split("#")[0];

/**
 * 动作让页面换了地址或换了文档（提交 GET 表单、点链接）时，最后读到的是旧文档在跳转前的读数，
 * 会把「换页了」说成「没变化」。这里改成明确的「加载了新文档」。
 */
async function withDocumentChange(tabId: number, token: string, report: EffectReport | undefined, startUrl: string, pageUrl: string): Promise<EffectReport | undefined> {
  const moved = !!startUrl && !!pageUrl && withoutHash(startUrl) !== withoutHash(pageUrl);
  // 新文档里没有这次的读数会话：读数变成 null，说明文档被换掉了。
  const replaced = report !== undefined && await callPage(tabId, (t: string) => window.__sideagent?.effect?.diff?.(t) ?? null, [token]).then(r => r === null, () => true);

  if (!moved && !replaced) return report;
  const base = report ?? EMPTY_EFFECT_REPORT;
  // 写明换到了哪一页：只说「加载了新文档」时，模型会再跑一轮去确认是不是要的那页（#257）。地址不带查询参数。
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = URL.canParse(tab?.url ?? pageUrl) ? new URL(tab?.url ?? pageUrl) : null;
  const where = [tab?.title ? `"${tab.title.slice(0, 120)}"` : "", url ? `${url.origin}${url.pathname}` : ""].filter(Boolean).join(" — ");

  return { ...base, changed: true, documentChanged: true, evidence: [...base.evidence, where ? `the page loaded a new document: ${where}` : "the page loaded a new document"] };
}

/** 读“新出现了什么”最多等这么久；超时只是这次不带摘要。 */
const PAGE_CHANGES_TIMEOUT_MS = 1500;

/**
 * 动作之后页面上有地方变了、又没换页时，读变过的那几处，只交回新出现的行（规则见 page-changes.ts）。
 * 换了页的沿用换页后的回执，不叠加；页面没变的不读，不多花时间。
 * 还原填写记下的旧值从摘要里去掉：旧值只能留在后台内存（fill-undo.ts）。
 */
export async function pageChangesAfter(tabId: number, sessionKey: string, report: EffectReport | undefined): Promise<PageAppeared | undefined> {
  if (!report || report.documentChanged) return undefined;

  const changed = changedRoots.get(report);

  return await finishAppeared(tabId, sessionKey, changed?.roots ?? null, changed?.since ?? Date.now(), 0, "effect");
}

type Roots = Array<{ sel: string; field?: true }> | "many";

/** 填写、选择之后：页面还在改 DOM 时最多等这么久，等它安静这么久。不等网络：会自动保存的编辑器每填一次都会发请求。 */
const WATCH_MAX_MS = 200;
const WATCH_QUIET_MS = 60;
const WATCH_POLL_MS = 40;

/** 填写、选择之前：只开始记页面上哪里变了。还没读过这一页（没有基准，摘要必然是空的）就不记，也就不等。失败返回 null。 */
export async function beginWatch(tabId: number): Promise<string | null> {
  if (!hasPageBaseline(tabId)) return null;
  const token = crypto.randomUUID();

  try {
    await ensureEffectScript(tabId);
    const ack = await callPage(tabId, (t: string) => window.__sideagent?.effect?.watch?.(t), [token]);

    return ack?.ok ? token : null;
  } catch {
    return null;
  }
}

/** 填写、选择自己出错时收掉页面里的变化记录。 */
export function endWatch(tabId: number, token: string): void {
  void callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]).catch(() => {});
}

/**
 * 填写、选择之后：页面同步画出来的（校验提示、跟着出来的栏）这时已经在了；页面还在改 DOM 就等它安静下来，最多 200 毫秒。
 * 不像点击那样轮询效果证据（要反复读全页文字），也不等网络。extraMs 是动作前花的时间。
 */
export async function watchChangesAfter(tabId: number, sessionKey: string, token: string, extraMs: number): Promise<PageAppeared | undefined> {
  const started = Date.now();
  let changed: Roots | null;

  try {
    for (;;) {
      const quiet = await callPage(tabId, (t: string) => window.__sideagent?.effect?.quietMs?.(t) ?? null, [token]).catch(() => null);

      if (quiet === null || quiet >= WATCH_QUIET_MS || Date.now() - started >= WATCH_MAX_MS) break;
      await new Promise(resolve => setTimeout(resolve, WATCH_POLL_MS));
    }
    changed = await callPage(tabId, (t: string) => window.__sideagent?.effect?.roots?.(t) ?? null, [token]).catch(() => null);
  } finally {
    endWatch(tabId, token);
  }

  return await finishAppeared(tabId, sessionKey, changed, started, extraMs, "watch");
}

async function finishAppeared(tabId: number, sessionKey: string, roots: Roots | null, started: number, extraMs: number, kind: "effect" | "watch"): Promise<PageAppeared> {
  const appeared = await readAppeared(tabId, sessionKey, roots);
  const ms = Date.now() - started + extraMs;
  // 只记花了多久、带回多少字，不记内容：验收按它算工具多花的时间。
  console.info("[page-changes]", JSON.stringify({ ms, chars: "text" in appeared ? appeared.text.length : -1, kind }));

  return { ...appeared, ms };
}

async function readAppeared(tabId: number, sessionKey: string, roots: Roots | null): Promise<{ text: string } | { redrawn: true }> {
  if (!roots) return { text: "" };

  if (roots === "many") return { redrawn: true };

  let live = true;

  try {
    const changes = await withTimeout(readPageChanges(tabId, roots, { scrub: undoScrubber(sessionKey), current: () => live }), PAGE_CHANGES_TIMEOUT_MS, "读新出现的内容超时");

    return { text: changes?.text ?? "" };
  } catch {
    return { text: "" };
  } finally {
    live = false;
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
    // 扩展自己写的记忆备份不是点击引起的下载。
    items = (await Promise.resolve(chrome.downloads.search({ startedAfter })).catch(() => [])).filter(i => !isOwnBackupDownload(i));
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
