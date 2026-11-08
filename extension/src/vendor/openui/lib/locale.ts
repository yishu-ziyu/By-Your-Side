// WHY: answers are read by the panel's user, not a US reader. Numbers, dates and money follow the viewer's language,
// and a currency the program did not name is never invented: an amount without a code shows as a plain number.
export const LOCALE = (typeof navigator !== "undefined" && navigator.language) || "en-US";

const CODE = /^[A-Za-z]{3}$/;

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, currency?: string | null): string {
  const { style, currency: _ignored, ...rest } = options;
  const money = style === "currency" && typeof currency === "string" && CODE.test(currency);
  try {
    return value.toLocaleString(LOCALE, money ? { ...rest, style, currency: currency!.toUpperCase() } : style === "currency" ? rest : options);
  } catch {
    return value.toLocaleString(LOCALE, rest);
  }
}

export function formatDate(at: Date, options: Intl.DateTimeFormatOptions): string {
  return at.toLocaleString(LOCALE, options);
}
