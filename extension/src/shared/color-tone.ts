/**
 * 界面底色色阶：只保留「淡蓝」与「暖纸」两套 1%–90% 同色系色阶。
 * 改完立即写入存储并切换当前页面的 data-tone，不用重开侧栏或刷新网页。
 */
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
    // 网页端无扩展域名 localStorage 权限或被禁用时忽略。
  }
}

/** 挂到根节点（documentElement 或 ShadowRoot 内的宿主元素），并随存储变化实时更新。 */
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
      // 扩展重载后上下文失效，直接忽略。
    }
  };
}
