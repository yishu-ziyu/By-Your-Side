import { isNudgeLink, isNudgePreparation, type NudgeLink, type NudgePreparation } from "../../../shared/nudge.js";

export const NUDGE_KEY = 'sideagent_nudge';

export function isNudgeOn(stored: unknown): stored is true {
  return stored === true;
}

export const NUDGE_PAGE = 'NUDGE_PAGE';

export type NudgePageMessage = { type: typeof NUDGE_PAGE; title: string; text: string; selection?: string; interacted: boolean };

export const NUDGE_SHOW = 'NUDGE_SHOW';

export type NudgeCard = { id: string; sentence: string; evidence: string; source: string; actionLabel: string; party?: string; url?: string; seenAt?: number; preparation?: NudgePreparation };

const optional = (v: object, key: string, type: 'string' | 'number' | 'boolean') => !(key in v) || (v as Record<string, unknown>)[key] === undefined || typeof (v as Record<string, unknown>)[key] === type;

export function isNudgeCard(v: unknown): v is NudgeCard {
  return !!v && typeof v === 'object'
    && 'id' in v && typeof v.id === 'string' && 'sentence' in v && typeof v.sentence === 'string'
    && 'evidence' in v && typeof v.evidence === 'string' && 'source' in v && typeof v.source === 'string'
    && 'actionLabel' in v && typeof v.actionLabel === 'string'
    && optional(v, 'party', 'string') && optional(v, 'url', 'string') && optional(v, 'seenAt', 'number')
    && (!('preparation' in v) || v.preparation === undefined || isNudgePreparation(v.preparation));
}

export const NUDGE_PANEL_KEY = 'sideagent_nudge_panel';
export const NUDGE_RESULTS_KEY = 'sideagent_nudge_results';

export interface PreparedNudgeTab extends NudgeLink { tabId: number; windowId: number; actualUrl: string; canUndo: boolean; loaded: boolean; closed?: boolean }
export interface NudgePreparationResult {
  state: 'opening' | 'opened' | 'stopped' | 'undone';
  opened: PreparedNudgeTab[];
  reused: NudgeLink[];
  message: string;
  clickedAt: number;
  firstActionAt?: number;
  completedAt?: number;
}
export type NudgePanelOffer = { conversationId: string; card: NudgeCard; at: number; requestedAt?: number; result?: NudgePreparationResult };
export type StoredNudgeOffer = NudgePanelOffer & { prompt: string; url: string; tabId: number; documentId?: string };

function isPreparationResult(v: unknown): v is NudgePreparationResult {
  if (!v || typeof v !== 'object') return false;
  return 'state' in v && ['opening', 'opened', 'stopped', 'undone'].includes(String(v.state))
    && 'opened' in v && Array.isArray(v.opened) && v.opened.length <= 3 && v.opened.every(tab => isNudgeLink(tab)
      && 'tabId' in tab && Number.isSafeInteger(tab.tabId) && 'windowId' in tab && Number.isSafeInteger(tab.windowId)
      && 'actualUrl' in tab && typeof tab.actualUrl === 'string'
      && 'canUndo' in tab && typeof tab.canUndo === 'boolean' && 'loaded' in tab && typeof tab.loaded === 'boolean'
      && optional(tab, 'closed', 'boolean'))
    && 'reused' in v && Array.isArray(v.reused) && v.reused.length <= 3 && v.reused.every(isNudgeLink)
    && 'message' in v && typeof v.message === 'string' && 'clickedAt' in v && typeof v.clickedAt === 'number'
    && optional(v, 'firstActionAt', 'number') && optional(v, 'completedAt', 'number');
}

export function isStoredNudgeOffer(v: unknown): v is StoredNudgeOffer {
  return isNudgePanelOffer(v) && 'prompt' in v && typeof v.prompt === 'string'
    && 'url' in v && nudgeableUrl(typeof v.url === 'string' ? v.url : undefined)
    && 'tabId' in v && Number.isSafeInteger(v.tabId) && optional(v, 'documentId', 'string');
}

type NudgeReceipt = StoredNudgeOffer & { result: NudgePreparationResult };
export function nudgeReceipts(value: unknown): NudgeReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.filter((offer): offer is NudgeReceipt => isStoredNudgeOffer(offer) && offer.result !== undefined);
}

export const NUDGE_PANEL_TTL_MS = 30 * 60_000;

export function isNudgePanelOffer(v: unknown): v is NudgePanelOffer {
  return !!v && typeof v === 'object' && 'conversationId' in v && typeof v.conversationId === 'string' && 'card' in v && isNudgeCard(v.card) && 'at' in v && typeof v.at === 'number' && Number.isFinite(v.at)
    && optional(v, 'requestedAt', 'number') && (!('result' in v) || v.result === undefined || isPreparationResult(v.result));
}

export type NudgePanelReply = { ok: true } | { ok: false; reason: 'busy' | 'offline' | 'gone' | 'stale' };

export const NUDGE_ACT = 'NUDGE_ACT';
export const NUDGE_UNDO = 'NUDGE_UNDO';

export const NUDGE_DRAFT_KEY = 'sideagent_nudge_draft';

export const NUDGE_DISMISS = 'NUDGE_DISMISS';

export const NUDGE_DWELL_MS = 15_000;

export const NUDGE_COOLDOWN_MS = 3 * 60_000;

export const NUDGE_AUTO_HIDE_MS = 12_000;

export function nudgeableUrl(raw: string | undefined): boolean {
  if (!raw) return false;

  try {
    const url = new URL(raw);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
