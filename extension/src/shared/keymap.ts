/**
 * press_key 键名 → CDP Input.dispatchKeyEvent 参数。
 * modifiers 位掩码：Alt=1, Ctrl=2, Meta=4, Shift=8。
 * 支持 "Control+A" / "Meta+A" / "Shift+Tab" 等组合（修饰键可用
 * Alt/Option、Control/Ctrl、Meta/Cmd/Command、Shift 别名）。
 * ControlOrMeta 按平台解析为 Meta（mac）或 Control（其它）。
 * 未知键返回 null。
 */
import { controlOrMetaKey } from "../../../shared/pointer-input.js";

export interface KeyInfo {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

function hostPlatform(): string {
  try {
    return typeof navigator !== "undefined" ? navigator.platform : process.platform;
  } catch {
    return "unknown";
  }
}

/** 把 ControlOrMeta 展开成当前平台的 Meta/Control。 */
export function expandControlOrMeta(input: string, platform: string = hostPlatform()): string {
  return input.replace(/\bControlOrMeta\b/gi, controlOrMetaKey(platform));
}

interface BaseKey {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const NAMED_KEYS: Record<string, BaseKey> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  control: { key: "Control", code: "ControlLeft", vk: 17 },
  ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
  meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  cmd: { key: "Meta", code: "MetaLeft", vk: 91 },
  command: { key: "Meta", code: "MetaLeft", vk: 91 },
  alt: { key: "Alt", code: "AltLeft", vk: 18 },
  option: { key: "Alt", code: "AltLeft", vk: 18 },
};

/** Alt/Ctrl/Meta 按下时不生成文本（避免控制字符），仅 Shift 允许。 */
function withText(info: KeyInfo, text: string | undefined): KeyInfo {
  if (text !== undefined && (info.modifiers & 7) === 0) info.text = text;

  return info;
}

export function resolveKey(input: string, platform: string = hostPlatform()): KeyInfo | null {
  if (typeof input !== "string") return null;
  const expanded = expandControlOrMeta(input, platform);
  const parts = expanded.split("+").map((p) => p.trim());

  if (parts.length === 0 || parts.some((p) => p === "")) return null;

  const keyName = parts[parts.length - 1]!;
  let modifiers = 0;

  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part.toLowerCase()];

    if (bit === undefined) return null;
    modifiers |= bit;
  }

  const lower = keyName.toLowerCase();

  const named = NAMED_KEYS[lower];

  if (named) {
    return withText(
      { key: named.key, code: named.code, windowsVirtualKeyCode: named.vk, modifiers },
      named.text,
    );
  }

  if (/^[a-z]$/.test(lower)) {
    const upper = lower.toUpperCase();
    const shift = (modifiers & 8) !== 0;
    const key = shift ? upper : lower;

    return withText(
      { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers },
      key,
    );
  }

  if (/^[0-9]$/.test(lower)) {
    return withText(
      { key: lower, code: `Digit${lower}`, windowsVirtualKeyCode: lower.charCodeAt(0), modifiers },
      lower,
    );
  }

  return null;
}
