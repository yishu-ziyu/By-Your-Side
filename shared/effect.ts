export const EFFECT_SCOPE_SEL =
  'section,form,[role=dialog],[role=listbox],[role=menu],main,article,[class*="modal" i],[class*="dialog" i],[class*="popover" i],[class*="dropdown" i]';

export const EFFECT_VOLATILE_WINDOW_MS = 60;

export const EFFECT_VOLATILE_DELTA = 3;

const EFFECT_SETTLE_INTERVAL_MS = 100;

const EFFECT_SETTLE_TIMEOUT_MS = 600;

export const EFFECT_SETTLE_MAX_MS = 3000;

const EFFECT_WEAK_DOM_DELTA = 3;

const EFFECT_WEAK_TEXT_DELTA = 4;

const EFFECT_SCOPE_TEXT_DELTA = 2;

export interface EffectTargetState {
  gone: boolean;
  tag: string;
  text?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  disabled?: string;
  paused?: string;
  ended?: string;
  cls?: string;
}

export interface EffectStats {
  els: number;
  bodyKids: number;
  active: string | null;
  bodyTextLen: number;
  target: EffectTargetState;
  targetActive: boolean;
  scopeKids: number;
  scopeTextLen: number;
  alerts: string[];
}

export interface EffectBaseline extends EffectStats {
  volatile: boolean;
}

export interface EffectReport {
  changed: boolean;
  evidence: string[];
  weak: string[];
  volatile: boolean;
  alerts: string[];
  documentChanged?: true;
}

export type PageAppeared = { text: string; ms: number } | { redrawn: true; ms: number };

export const EMPTY_EFFECT_REPORT: EffectReport = { changed: false, evidence: [], weak: [], volatile: false, alerts: [] };

const isFiniteDelta = (delta: number, threshold: number) => Number.isFinite(delta) && Math.abs(delta) >= threshold;

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export function diffEffect(base: EffectBaseline, now: EffectStats): EffectReport {
  const evidence: string[] = [];
  const weak: string[] = [];

  const bt = base.target, nt = now.target;

  if (nt.gone && !bt.gone) evidence.push("target removed from the page");
  else if (!nt.gone) {
    for (const key of ["text", "expanded", "checked", "selected", "value", "disabled", "paused", "ended"] as const) {
      const before = bt[key], after = nt[key];

      if (before === undefined || before === after) continue;
      evidence.push(`${key} ${before || "(empty)"} → ${after || "(empty)"}`);
    }

    if (bt.cls !== undefined && bt.cls !== nt.cls) evidence.push("target class changed");
  }

  const fresh = now.alerts.filter((alert) => !base.alerts.includes(alert));

  if (fresh.length) evidence.push(`⚠ page notice: ${fresh.join(" / ")}`);

  const dBodyKids = now.bodyKids - base.bodyKids;

  if (dBodyKids !== 0) {
    evidence.push(
      dBodyKids > 0
        ? `page top level +${dBodyKids} element(s) (likely dialog/overlay/toast)`
        : `page top level ${dBodyKids} element(s) (likely a whole block replaced)`,
    );
  }

  const dScopeKids = now.scopeKids - base.scopeKids;

  if (dScopeKids !== 0) evidence.push(`target region DOM ${signed(dScopeKids)} node(s)`);
  else if (evidence.length === 0 || (evidence.length === 1 && evidence[0] === "target class changed")) {
    const dScopeText = now.scopeTextLen - base.scopeTextLen;

    if (isFiniteDelta(dScopeText, EFFECT_SCOPE_TEXT_DELTA)) {
      evidence.push(`target region text ${signed(dScopeText)} char(s)`);
    }
  }

  const dEls = now.els - base.els;

  if (isFiniteDelta(dEls, EFFECT_WEAK_DOM_DELTA)) weak.push(`DOM ${signed(dEls)} node(s)`);
  const dText = now.bodyTextLen - base.bodyTextLen;

  if (dText !== 0 && isFiniteDelta(dText, EFFECT_WEAK_TEXT_DELTA)) weak.push(`body text ${signed(dText)} char(s)`);
  const focusMoved = now.active !== base.active && !now.targetActive;

  if (focusMoved) weak.push(`focus → ${now.active ?? "(none)"}`);

  return { changed: evidence.length > 0, evidence, weak, volatile: !!base.volatile, alerts: fresh };
}

interface EffectRequest {
  method: string;
  url: string;
  resourceType: string;
  startedAt: number;
  status?: number;
  endedTs?: number;
  failed?: string;
  canceled?: boolean;
}

const QUIET_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const QUIET_TYPES = new Set(["ping", "preflight", "cspviolationreport"]);

function siteOf(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;

  return hostname.split(".").slice(-2).join(".");
}

function redactPath(pathname: string): string {
  return pathname.split("/").map(seg => (seg.length >= 8 && /\d/.test(seg) && /[a-z]/i.test(seg)) || seg.length >= 24 ? "*" : seg).join("/");
}

export function requestEvidence(requests: readonly EffectRequest[], since: number, until: number, pageUrl: string): string[] {
  let pageSite: string;

  try {
    pageSite = siteOf(new URL(pageUrl).hostname);
  } catch {
    return [];
  }

  const sent = requests.flatMap(r => {
    if (r.startedAt < since || r.startedAt > until || QUIET_METHODS.has(r.method.toUpperCase()) || QUIET_TYPES.has(r.resourceType)) return [];

    try {
      const u = new URL(r.url);

      return siteOf(u.hostname) === pageSite ? [`page sent ${r.method.toUpperCase()} ${u.host}${redactPath(u.pathname)}`] : [];
    } catch {
      return [];
    }
  });

  return sent.length > 3 ? [...sent.slice(0, 3), `and ${sent.length - 3} more request(s)`] : sent;
}

const WAITED_TYPES = new Set(["xhr", "fetch", "document"]);

export function pendingRequests(requests: readonly EffectRequest[], since: number, pageUrl: string): number {
  let pageSite: string;

  try {
    pageSite = siteOf(new URL(pageUrl).hostname);
  } catch {
    return 0;
  }

  return requests.filter(r => {
    if (r.startedAt < since || r.status !== undefined || r.endedTs !== undefined || r.failed !== undefined || r.canceled || !WAITED_TYPES.has(r.resourceType)) return false;

    try {
      return siteOf(new URL(r.url).hostname) === pageSite;
    } catch {
      return false;
    }
  }).length;
}

export interface EffectDownload {
  url: string;
  referrer: string;
  filename: string;
  path: string;
  state: "in_progress" | "interrupted" | "complete";
  bytes?: number;
  error?: string;
  danger?: string;
}

export function downloadEvidence(downloads: readonly EffectDownload[], pageUrl: string): string[] {
  let pageSite: string;

  try {
    pageSite = siteOf(new URL(pageUrl).hostname);
  } catch {
    return [];
  }

  const sameSite = (raw: string) => {
    try {
      return siteOf(new URL(raw).hostname) === pageSite;
    } catch {
      return false;
    }
  };

  return downloads.filter(d => sameSite(d.referrer) || sameSite(d.url)).map(d => {
    const head = `a download "${d.filename}" started while this click was processed`;

    if (d.state === "complete") return `${head}; Chrome's downloads API reports it complete: saved to ${d.path}${d.bytes !== undefined ? ` (${d.bytes} B)` : ""}. If this is the file you meant to get, it is already saved: do not export it again just to confirm it`;

    if (d.state === "interrupted") return `${head} but Chrome reports it failed (${d.error ?? "interrupted"}); no complete file was saved`;

    if (d.danger) return `${head}; Chrome flagged it as ${d.danger} and holds it until the user chooses Keep in Chrome's downloads. Not saved yet`;

    return `${head}; Chrome has not reported it finished yet, so it is not saved yet. Do not report it as saved`;
  });
}

export const UNSAVED_FIELDS_ALERT = "show a value different from what you filled";

export function formatEffectReport(report: EffectReport | undefined, action = "click"): string {
  if (!report) return "";
  const detail = [...report.evidence, ...report.weak].join("; ");

  const alerts = report.alerts.length ? ` Warning: ${report.alerts.join("; ")}.` : "";

  if (report.changed) return ` Page reacted: ${detail}.${alerts}`;

  const tail = report.volatile
    ? ` The page itself keeps changing, but nothing was attributable to this ${action}`
    : ` Nothing on the page changed in a way attributable to this ${action}`;

  const weak = report.weak.length ? ` (${report.weak.join("; ")})` : "";

  return `${tail}${weak}. Likely causes: the element is only a container and the real control is inside or beside it; the effect is asynchronous; or the page ignored this input. Observe the page and check whether it took effect where its result would show (a list, a message, another page). Retry the normal action once only if it clearly did not; never repeat a submit, send or create whose result you cannot see. If it still has no effect, stop and tell the user which step had no effect.`;
}

export async function settleEffectReport(
  poll: () => Promise<EffectReport | null | undefined>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number; maxMs?: number; pending?: () => number } = {},
): Promise<EffectReport | undefined> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? EFFECT_SETTLE_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? EFFECT_SETTLE_INTERVAL_MS;
  const start = now();
  const deadline = start + timeoutMs;
  const hardDeadline = start + (opts.maxMs ?? EFFECT_SETTLE_MAX_MS);
  let last: EffectReport | undefined;
  let waited = false;

  for (;;) {
    const report = await poll();

    if (report) last = report;
    const busy = (opts.pending?.() ?? 0) > 0;

    if (busy) {
      waited = true;

      if (now() >= hardDeadline) return last;
    } else if (waited) {
      waited = false;
    } else if (last?.changed || now() >= deadline) return last;

    await sleep(intervalMs);
  }
}
