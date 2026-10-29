/** Detect copied ordinary-looking words, not code, addresses or capitalized names. The model adjudicates ambiguous names in one repair pass. */
export function untranslatedReadingWords(source: string, translation: string): string[] {
  const prose = (value: string) => value.replace(/```[\s\S]*?(?:```|$)|`[^`]*`|https?:\/\/\S+|\[[^\]]*\]\([^)]*\)/g, ' ');
  const original = prose(source);
  if ((original.match(/[\p{Script=Han}]/gu)?.length ?? 0) * 2 >= (original.match(/[a-z]/gi)?.length ?? 0)) return [];
  const words = new Set(original.match(/\b[a-z][a-z'-]{2,}\b/g) ?? []);
  return [...new Set(prose(translation).match(/\b[a-z][a-z'-]{2,}\b/g) ?? [])].filter(word => words.has(word)).slice(0, 32);
}

export interface ReadingTranslationRepair { translation: string; keptNames: string[] }

export function isReadingTranslationRepair(value: unknown): value is ReadingTranslationRepair {
  if (!value || typeof value !== 'object') return false;
  return 'translation' in value && typeof value.translation === 'string' && !!value.translation.trim()
    && value.translation.length <= 12000 && 'keptNames' in value && Array.isArray(value.keptNames)
    && value.keptNames.length <= 32 && value.keptNames.every(name => typeof name === 'string' && name.length <= 100);
}
