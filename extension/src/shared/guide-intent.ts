export type GuideTargetKind = "click" | "input" | "select";

export interface GuideTargetDescriptor {
  tagName: string;
  inputType?: string;
  role?: string;
  contentEditable?: boolean;
}

export interface GuideInputSnapshot {
  value: string;
  sensitive: boolean;
}

export const GUIDE_INPUT_SETTLE_MS = 1400;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "hidden",
  "color",
  "range",
]);

const SENSITIVE_NAME_RE = /pass(word|code|phrase)?|secret|token|pin|otp|cvv|cvc|ssn|密码|口令|验证码/i;

export function classifyGuideTarget(desc: GuideTargetDescriptor): GuideTargetKind {
  const tag = desc.tagName.toLowerCase();
  const role = (desc.role ?? "").toLowerCase();

  if (tag === "select") return "select";
  if (tag === "textarea") return "input";
  if (desc.contentEditable) return "input";

  if (tag === "input") {
    const type = (desc.inputType ?? "text").toLowerCase();

    return NON_TEXT_INPUT_TYPES.has(type) ? "click" : "input";
  }

  if (role === "textbox" || role === "searchbox") return "input";

  return "click";
}

export function isSensitiveGuideField(inputType?: string, labelOrName?: string): boolean {
  if ((inputType ?? "").toLowerCase() === "password") return true;

  return Boolean(labelOrName && SENSITIVE_NAME_RE.test(labelOrName));
}

export function formatGuideFieldAfter(
  roleOrTag: string,
  name: string,
  snapshot: GuideInputSnapshot,
): string {
  const safeName = name ? `"${name.slice(0, 40)}"` : "";

  if (snapshot.sensitive) {
    return [roleOrTag, safeName, "filled=true (redacted)"].filter(Boolean).join(" ").slice(0, 120);
  }

  const clipped = snapshot.value.trim().replace(/\s+/g, " ").slice(0, 50);

  return [roleOrTag, safeName, `value="${clipped}"`].filter(Boolean).join(" ").slice(0, 120);
}

export function shouldCompleteInput(initial: string, current: string, trigger: "enter" | "blur" | "change" | "idle"): boolean {
  if (current === initial) return false;
  if (trigger === "idle") return current.trim().length > 0;

  return true;
}

export function guideInputWaitingCopy(name: string): string {
  return name ? `请在「${name}」里输入内容，输完按回车或点空白处即可。` : "请在这里输入内容，输完按回车或点空白处即可。";
}

export function guideSelectWaitingCopy(name: string): string {
  return name ? `请从「${name}」里选好需要的选项。` : "请从下拉列表里选好需要的选项。";
}
