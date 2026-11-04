export const ATTENTION_CUES_KEY = 'sideagent_attention_cues';

export function isCuesOn(stored: unknown): boolean {
  return stored !== false;
}
