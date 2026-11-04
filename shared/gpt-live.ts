export const GPT_LIVE_CONTEXT_BYTES = 480;

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export function clipUtf8(text: string, budget: number): string {
  let result = '';
  let used = 0;

  for (const character of text) {
    const size = utf8Bytes(character);

    if (used + size > budget) break;
    result += character;
    used += size;
  }

  return result;
}
