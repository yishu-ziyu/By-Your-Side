/** [lat, lng]. */
export type LatLng = [number, number];

export const coordinate = (input: unknown): LatLng | null => {
  if (!input || typeof input !== "object") return null;
  const { lat, lng } = input as { lat?: unknown; lng?: unknown };
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? [lat, lng] : null;
};

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Pins are round and sized for one emoji. Use the first character only if it
// is an emoji, so a word or letter from the model can't overflow the pin.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function pinEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const first = graphemes.segment(value.trim())[Symbol.iterator]().next().value?.segment;
  return first && /\p{Extended_Pictographic}/u.test(first) ? first : null;
}
