/** Wire contract for document-bound translation. Model output is text, never HTML. */
export type TranslationFont = 'original' | 'songti';

export type TranslationPageResult = Omit<TranslationReceipt, 'tabId'> | {error: string; executionFact: 'not_executed' | 'unknown'};

export type TranslationMode = 'bilingual' | 'translated';

export interface TranslationSegment { id: string; text: string }

export interface TranslationBlock { id: string; segments: TranslationSegment[] }

export interface TranslationReceipt {
  tabId: number;
  document: string;
  language: string;
  mode: TranslationMode;
  fontSize: number | null;
  translated: number;
  remaining: number;
  unsupported: number;
  blocks: TranslationBlock[];
  applied?: number;
  /** model-output: the model never returned matching text for some paragraphs; they stay untranslated (remaining). */
  incompleteReason?: 'page-changing' | 'batch-limit' | 'model-output';
}

export interface TranslationCommand {
  tabId?: number;
  /** settle: the translation run ended (done, failed or stopped); remove every pending-paragraph mark. */
  action: 'begin' | 'collect' | 'apply' | 'display' | 'restore' | 'settle';
  document?: string;
  language?: string;
  mode?: TranslationMode;
  fontSize?: number;
  fontFamily?: TranslationFont;
  translations?: TranslationSegment[];
  /** settle only: remove the placeholders after this many ms unless another translation call starts first. */
  delayMs?: number;
  /** collect only: block ids already being translated elsewhere; skip them so concurrent batches never overlap. */
  exclude?: string[];
  /** collect only: at most this many blocks (1–8). The first batches stay small so the visible paragraphs land first. */
  maxBlocks?: number;
}

export interface TranslationRequest {
  tabId?: number;
  action: 'translate' | 'display' | 'restore';
  language?: string;
  mode?: TranslationMode;
  fontSize?: number;
  fontFamily?: TranslationFont;
  /** Bind a display request to a previously observed translation instance. */
  document?: string;
}

export function validateTranslationCommand(p: TranslationCommand): void {
  if (!p || !['begin', 'collect', 'apply', 'display', 'restore', 'settle'].includes(p.action)) throw new Error('未知翻译操作');

  if (p.mode !== undefined && !['bilingual', 'translated'].includes(p.mode)) throw new Error('无效的翻译显示方式');

  if (p.language !== undefined && (typeof p.language !== 'string' || !p.language.trim() || p.language.length > 80)) throw new Error('无效的目标语言');

  if (p.fontSize !== undefined && (!Number.isFinite(p.fontSize) || p.fontSize < 10 || p.fontSize > 48)) throw new Error('译文字号范围为 10–48 像素');

  if (p.fontFamily !== undefined && !['original', 'songti'].includes(p.fontFamily)) throw new Error('无效的译文字体');

  if (p.document !== undefined && (typeof p.document !== 'string' || p.document.length > 100)) throw new Error('无效的文档身份');

  if (p.delayMs !== undefined && (p.action !== 'settle' || !Number.isFinite(p.delayMs) || p.delayMs < 0 || p.delayMs > 60_000)) throw new Error('无效的收尾延迟');

  if (p.exclude !== undefined && (p.action !== 'collect' || !Array.isArray(p.exclude) || p.exclude.length > 512 || p.exclude.some(id => String(id) !== id || !/^\d{1,20}$/.test(id)))) throw new Error('无效的排除段落');

  if (p.maxBlocks !== undefined && (p.action !== 'collect' || !Number.isInteger(p.maxBlocks) || p.maxBlocks < 1 || p.maxBlocks > 8)) throw new Error('无效的批次上限');

  if (p.action === 'apply' && (!p.document || !Array.isArray(p.translations) || p.translations.length > 64 || p.translations.some(s => !s || typeof s.id !== 'string' || s.id.length > 80 || typeof s.text !== 'string' || s.text.length > 24000))) throw new Error('无效的译文批次');
}

/** Read-only current translation identity and rendered display state. */
export interface TranslationDisplayState {
  document: string;
  mode: TranslationMode;
  fontFamily: TranslationFont;
  translated: number;
  displayValid: boolean;
}
