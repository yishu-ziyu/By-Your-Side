/** Wire contract for document-bound translation. Model output is text, never HTML. */
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
}
export interface TranslationCommand {
  tabId?: number;
  action: 'begin' | 'collect' | 'apply' | 'display' | 'restore';
  document?: string;
  language?: string;
  mode?: TranslationMode;
  fontSize?: number;
  translations?: TranslationSegment[];
}
export interface TranslationRequest {
  tabId?: number;
  action: 'translate' | 'display' | 'restore';
  language?: string;
  mode?: TranslationMode;
  fontSize?: number;
}
export function validateTranslationCommand(p: TranslationCommand): void {
  if (!p || !['begin', 'collect', 'apply', 'display', 'restore'].includes(p.action)) throw new Error('未知翻译操作');
  if (p.mode !== undefined && !['bilingual', 'translated'].includes(p.mode)) throw new Error('无效的翻译显示方式');
  if (p.language !== undefined && (typeof p.language !== 'string' || !p.language.trim() || p.language.length > 80)) throw new Error('无效的目标语言');
  if (p.fontSize !== undefined && (!Number.isFinite(p.fontSize) || p.fontSize < 10 || p.fontSize > 48)) throw new Error('译文字号范围为 10–48 像素');
  if (p.document !== undefined && (typeof p.document !== 'string' || p.document.length > 100)) throw new Error('无效的文档身份');
  if (p.action === 'apply' && (!p.document || !Array.isArray(p.translations) || p.translations.length > 64 || p.translations.some(s => !s || typeof s.id !== 'string' || s.id.length > 80 || typeof s.text !== 'string' || s.text.length > 24000))) throw new Error('无效的译文批次');
}
