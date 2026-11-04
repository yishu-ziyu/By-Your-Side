import { EMPTY_EFFECT_REPORT, downloadEvidence, pendingRequests, requestEvidence, settleEffectReport, type EffectDownload, type EffectReport, type PageAppeared } from "../../../../shared/effect.js";
import { undoScrubber } from "../fill-undo.js";
import { networkRingFor } from "../network-log.js";
import { withTimeout } from "../timeout.js";
import { hasPageBaseline } from "../page-changes.js";
import { readPageChanges } from "./snapshot.js";
import { isOwnBackupDownload } from "../../shared/memory-backup.js";

const CONTENT_FILE = "content-effect.js";

const changedRoots = new WeakMap<EffectReport, { roots: Array<{ sel: string; field?: true }> | "many"; since: number }>();

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

export async function beginEffect(
  tabId: number,
  input: { point?: [number, number]; selector?: string } = {},
): Promise<string | null> {
  const token = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    await ensureEffectScript(tabId);
    const payload: EffectInput = { token, ...input };

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

export async function collectEffect(tabId: number, token: string | null, mark?: (phase: string) => void): Promise<EffectReport | undefined> {
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
    mark?.("settle");

    const pageUrl = since === undefined ? "" : await chrome.tabs.get(tabId).then(tab => tab.url ?? "", () => "");
    const report = await withDocumentChange(tabId, token, settled, startUrl, pageUrl);

    const rootsAt = Date.now();
    const roots = await callPage(tabId, (t: string) => window.__sideagent?.effect?.roots?.(t) ?? null, [token]).catch(() => null);
    const sent = since === undefined ? [] : [
      ...requestEvidence(networkRingFor(tabId)?.entries ?? [], since, Date.now(), pageUrl),
      ...downloadEvidence(await clickDownloads(tabId, since).catch(() => []), pageUrl),
    ];

    const final = !sent.length ? report : { ...(report ?? EMPTY_EFFECT_REPORT), changed: true, evidence: [...(report ?? EMPTY_EFFECT_REPORT).evidence, ...sent] };

    if (final && roots) changedRoots.set(final, { roots, since: rootsAt });
    mark?.("evidence");

    return final;
  } finally {
    effectStarts.delete(token);

    try {
      await callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]);
    } catch {
    }
  }
}

const withoutHash = (url: string) => url.split("#")[0];

async function withDocumentChange(tabId: number, token: string, report: EffectReport | undefined, startUrl: string, pageUrl: string): Promise<EffectReport | undefined> {
  const moved = !!startUrl && !!pageUrl && withoutHash(startUrl) !== withoutHash(pageUrl);
  const replaced = report !== undefined && await callPage(tabId, (t: string) => window.__sideagent?.effect?.diff?.(t) ?? null, [token]).then(r => r === null, () => true);

  if (!moved && !replaced) return report;
  const base = report ?? EMPTY_EFFECT_REPORT;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = URL.canParse(tab?.url ?? pageUrl) ? new URL(tab?.url ?? pageUrl) : null;
  const where = [tab?.title ? `"${tab.title.slice(0, 120)}"` : "", url ? `${url.origin}${url.pathname}` : ""].filter(Boolean).join(" — ");

  return { ...base, changed: true, documentChanged: true, evidence: [...base.evidence, where ? `the page loaded a new document: ${where}` : "the page loaded a new document"] };
}

const PAGE_CHANGES_TIMEOUT_MS = 1500;

export async function pageChangesAfter(tabId: number, sessionKey: string, report: EffectReport | undefined): Promise<PageAppeared | undefined> {
  if (!report || report.documentChanged) return undefined;

  const changed = changedRoots.get(report);

  return await finishAppeared(tabId, sessionKey, changed?.roots ?? null, changed?.since ?? Date.now(), 0, "effect");
}

type Roots = Array<{ sel: string; field?: true }> | "many";

const WATCH_MAX_MS = 200;
const WATCH_QUIET_MS = 60;
const WATCH_POLL_MS = 40;

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

export function endWatch(tabId: number, token: string): void {
  void callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]).catch(() => {});
}

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

const DOWNLOAD_WAIT_MS = 3000;

async function clickDownloads(tabId: number, since: number): Promise<EffectDownload[]> {
  if (!chrome.downloads?.search) return [];
  const startedAfter = new Date(since - 50).toISOString();
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  let items: chrome.downloads.DownloadItem[] = [];

  for (;;) {
    const found = await Promise.resolve(chrome.downloads.search({ startedAfter })).catch(() => []);
    const owned = await Promise.all(found.map(isOwnBackupDownload));
    items = found.filter((_, index) => !owned[index]);
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
      state: i.state as EffectDownload["state"],
      bytes: i.state === "complete" ? (i.fileSize >= 0 ? i.fileSize : i.bytesReceived) : undefined,
      error: i.error,
      danger: i.danger && i.danger !== "safe" && i.danger !== "accepted" ? i.danger : undefined,
    };
  });
}
