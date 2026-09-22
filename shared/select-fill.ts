/** Match a <select> option by visible label or value. Used by fill. */
export function matchSelectOption(
  options: ReadonlyArray<{ text: string; value: string }>,
  wanted: string,
): { value: string; text: string } | null {
  const needle = wanted.trim();

  if (!needle) return null;
  const list = options.filter((o) => o.text.trim() !== "");
  const exact = list.find((o) => o.text.trim() === needle || o.value === needle);

  if (exact) return exact;
  const contains = list.find((o) => o.text.includes(needle) || needle.includes(o.text.trim()));

  return contains ?? null;
}
