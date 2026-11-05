export const COLOR_TONES = [
  { id: "blue", label: "淡蓝", summary: "带一点蓝的白底与深蓝黑字" },
  { id: "warm", label: "暖纸", summary: "偏暖的米纸底与暖黑字" },
] as const;

export type ColorTone = typeof COLOR_TONES[number]["id"];

export const DEFAULT_COLOR_TONE: ColorTone = "blue";

export const COLOR_TONE_KEY = "color_tone";

export function parseColorTone(value: unknown): ColorTone {
  return COLOR_TONES.find((tone) => tone.id === value)?.id ?? DEFAULT_COLOR_TONE;
}

function readCachedTone(): ColorTone {
  try {
    return parseColorTone(localStorage.getItem(COLOR_TONE_KEY));
  } catch {
    return DEFAULT_COLOR_TONE;
  }
}

export function writeCachedTone(tone: ColorTone): void {
  try {
    localStorage.setItem(COLOR_TONE_KEY, tone);
  } catch {
  }
}

export function syncColorTone(target: HTMLElement = document.documentElement): () => void {
  const apply = (tone: ColorTone) => {
    target.dataset.tone = tone;
    if (location.protocol === "chrome-extension:") writeCachedTone(tone);
  };

  apply(location.protocol === "chrome-extension:" ? readCachedTone() : DEFAULT_COLOR_TONE);

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && COLOR_TONE_KEY in changes) {
      apply(parseColorTone(changes[COLOR_TONE_KEY]!.newValue));
    }
  };

  try {
    chrome.storage.onChanged.addListener(onChanged);
    void chrome.storage.local.get(COLOR_TONE_KEY).then(
      (stored) => apply(parseColorTone(stored[COLOR_TONE_KEY])),
      () => apply(DEFAULT_COLOR_TONE),
    );
  } catch {
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(onChanged);
    } catch {
    }
  };
}

export const COLOR_SCHEMES = [
  { id: "auto", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
] as const;

export type ColorScheme = typeof COLOR_SCHEMES[number]["id"];

export const DEFAULT_COLOR_SCHEME: ColorScheme = "auto";

export const COLOR_SCHEME_KEY = "color_scheme";

export function parseColorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEMES.find((scheme) => scheme.id === value)?.id ?? DEFAULT_COLOR_SCHEME;
}

function readCachedScheme(): ColorScheme {
  try {
    return parseColorScheme(localStorage.getItem(COLOR_SCHEME_KEY));
  } catch {
    return DEFAULT_COLOR_SCHEME;
  }
}

export function writeCachedScheme(scheme: ColorScheme): void {
  try {
    localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  } catch {
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

const DARK_RULE = /^\(prefers-color-scheme:\s*dark\)$/;

let activeScheme: ColorScheme = DEFAULT_COLOR_SCHEME;

const schemeListeners = new Set<() => void>();

export function isDarkScheme(): boolean {
  if (activeScheme !== "auto") return activeScheme === "dark";

  return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
}

export function onColorSchemeChange(listener: () => void): void {
  schemeListeners.add(listener);
}

// WHY: every dark token lives in a prefers-color-scheme block, and CSS cannot OR a media query with an attribute, so a forced choice rewrites those rules in place instead of duplicating all of them.
function forceDarkRules(rules: CSSRuleList, scheme: ColorScheme, original: WeakMap<CSSMediaRule, string>): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSImportRule) {
      if (rule.styleSheet) forceDarkRules(rule.styleSheet.cssRules, scheme, original);
    } else if (rule instanceof CSSMediaRule) {
      const text = original.get(rule) ?? rule.media.mediaText;

      if (DARK_RULE.test(text)) {
        original.set(rule, text);
        rule.media.mediaText = scheme === "auto" ? text : scheme === "dark" ? "all" : "not all";
      }
    }
  }
}

export function syncColorScheme(doc: Document = document): void {
  const original = new WeakMap<CSSMediaRule, string>();
  const apply = (scheme: ColorScheme) => {
    activeScheme = scheme;
    writeCachedScheme(scheme);

    for (const sheet of Array.from(doc.styleSheets)) forceDarkRules(sheet.cssRules, scheme, original);
    for (const listener of schemeListeners) listener();
  };

  apply(readCachedScheme());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && COLOR_SCHEME_KEY in changes) apply(parseColorScheme(changes[COLOR_SCHEME_KEY]!.newValue));
  });
  void chrome.storage.local.get(COLOR_SCHEME_KEY).then((stored) => {
    const scheme = parseColorScheme(stored[COLOR_SCHEME_KEY]);

    if (scheme !== activeScheme) apply(scheme);
  });
}
