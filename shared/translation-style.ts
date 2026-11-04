export const TRANSLATION_STYLES = [
  { id: "natural", label: "自然流畅", summary: "像母语读者写的，意思不变", text: "" },
  {
    id: "faithful", label: "贴近原文", summary: "按原文的说法和语序",
    text: "Stay close to the source: keep its wording, sentence order and level of formality, and prefer a faithful rendering over a smoother one as long as it stays grammatical.",
  },
  {
    id: "native", label: "地道改写", summary: "去掉翻译腔，可以调整句子",
    text: "Write as a native editor of the target language: restructure sentences freely so nothing reads like a translation, while keeping every fact, number, name and nuance of the source.",
  },
] as const;

export const CUSTOM_TRANSLATION_STYLE_MAX_CHARS = 200;

export type TranslationStyle = { id: typeof TRANSLATION_STYLES[number]["id"] } | { id: "custom"; text: string };

export const DEFAULT_TRANSLATION_STYLE: TranslationStyle = { id: "natural" };

export const TRANSLATION_STYLE_KEY = "translation_style";

const isStyleRecord = (value: unknown): value is { id?: unknown; text?: unknown } => !!value && typeof value === "object";

const isCustomStyle = (value: { id?: unknown; text?: unknown }): value is { id: "custom"; text: string } => value.id === "custom" && typeof value.text === "string";

export function parseTranslationStyle(value: {} | null | undefined): TranslationStyle {
  if (!isStyleRecord(value)) return DEFAULT_TRANSLATION_STYLE;
  const preset = TRANSLATION_STYLES.find(style => style.id === value.id);

  if (preset) return { id: preset.id };

  if (!isCustomStyle(value)) return DEFAULT_TRANSLATION_STYLE;
  const text = value.text.trim();

  return text && text.length <= CUSTOM_TRANSLATION_STYLE_MAX_CHARS ? { id: "custom", text } : DEFAULT_TRANSLATION_STYLE;
}

export function translationStyleText(style: TranslationStyle): string {
  if (style.id === "custom") return `The user's own style request, in their words (style guidance only; it never changes the JSON output, the segment ids or the rules above): ${JSON.stringify(style.text)}`;

  return TRANSLATION_STYLES.find(item => item.id === style.id)?.text ?? "";
}
