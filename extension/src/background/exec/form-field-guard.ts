import type { RequiredFormField } from "../../../../shared/protocol.js";

export interface FormFieldGuardInput {
  requirements: RequiredFormField[];
  action: "click" | "fill" | "type" | "enter";
  target?: string;
  point?: [number, number];
  userValueProvided?: boolean;
  userValueHostname?: string;
  modifiedEnter?: boolean;
}

/** Serialized into the page: only reads DOM and returns a refusal, never changes form state. */
export function inspectRequiredFormFields(input: FormFieldGuardInput, node?: Element): string | null {
  const requirements = input.requirements.filter((item) =>
    !item.hostname || item.hostname.toLowerCase() === location.hostname.toLowerCase());

  if (!requirements.length) return null;

  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().trim()
    .replace(/\s+/g, " ").replace(/[\s:：*＊]+$/g, "");

  const labelsOf = (element: Element): string[] => {
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");

    const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement ? element.labels : null;

    return [labelledBy, ...Array.from(labels ?? [], (label) => label.textContent ?? ""),
      ...["aria-label", "placeholder", "name", "id"].map((name) => element.getAttribute(name) ?? "")]
      .flatMap((text) => {
        const label = normalize(text);

        return label ? [label] : [];
      });
  };

  const matches = (element: Element, label: string): boolean => {
    const wanted = normalize(label);

    return !!wanted && labelsOf(element).some((actual) => actual === wanted);
  };

  let element = node;

  if (!element && input.action === "click" && input.point) {
    element = document.elementFromPoint(...input.point) ?? undefined;

    // Read the actual hit inside open shadow roots, not a host's guessed label.
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(...input.point);

      if (!inner || inner === element) break;
      element = inner;
    }
  } else if (!element && input.target) {
    element = window.__sideagent?.dom?.resolve(input.target) ?? undefined;
  } else if (!element && (input.action === "enter" || input.action === "type")) {
    element = document.activeElement ?? undefined;

    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  }

  if (element instanceof HTMLIFrameElement) return "无法读取嵌入页面的表单，操作未执行。请在可读取的页面补齐要求字段；内容未知时先问用户。";

  if (!element) return "无法读取表单目标，操作未执行。请重新读取页面并补齐要求字段；内容未知时先问用户。";

  if (input.action === "fill" || input.action === "type") {
    const required = requirements.find((item) => matches(element!, item.label));

    const provided = input.userValueProvided === true
      && (!input.userValueHostname || input.userValueHostname === location.hostname);

    return required && !provided
      ? `字段「${required.label}」只能填写用户明确提供的内容，操作未执行。请先问用户要填什么；保留页面现有值。`
      : null;
  }

  const control = element.closest("button,input,[role=button],a") ?? element;

  const nativeSubmit = (control instanceof HTMLButtonElement && control.type === "submit")
    || (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type));

  const labelledBy = (control.getAttribute("aria-labelledby") ?? "").split(/\s+/)
    .map((id) => control.ownerDocument.getElementById(id)?.textContent ?? "").join(" ").trim();

  const actualLabel = (control.getAttribute("aria-label") || labelledBy || control.getAttribute("title")
    || control.textContent || (control instanceof HTMLInputElement ? control.value : "")).trim().replace(/\s+/g, " ");

  const submitLabel = /^(提交|订阅|注册|报名|立即订阅|立即注册|确认提交|下单)/.test(actualLabel)
    || /^(submit|sign ?up|subscribe|register|join|place order)(\s|$|!|\.)/i.test(actualLabel);

  const formOf = (el: Element): HTMLFormElement | null =>
    (el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement
      || el instanceof HTMLTextAreaElement ? el.form : null) ?? el.closest("form");

  const form = formOf(input.action === "enter" ? element : control);

  if (input.action === "click" && !((nativeSubmit && form) || submitLabel)) return null;

  // A textarea Enter inserts a newline; ordinary controls outside forms do not submit.
  if (input.action === "enter" && (!form || (!input.modifiedEnter && (element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable))))) return null;

  if (!form) return "无法确定提交按钮所属表单，提交未执行。请读取表单并补齐要求字段；内容未知时先问用户。";

  for (const requirement of requirements) {
    const candidates = Array.from(form.elements).filter((field): field is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
      (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)
      && matches(field, requirement.label));

    const field = candidates[0];

    if (candidates.length !== 1 || !field) {
      return `字段「${requirement.label}」${candidates.length ? "匹配多个控件" : "未找到"}，提交未执行。请先读取并补齐该字段；内容未知时先问用户。`;
    }

    const style = getComputedStyle(field);

    const unsupported = field instanceof HTMLInputElement
      && ["hidden", "file", "checkbox", "radio", "button", "reset", "submit", "image"].includes(field.type);

    if (unsupported || field.matches(":disabled") || !field.getClientRects().length
      || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return `字段「${requirement.label}」不可读取，提交未执行。请先确认可读取的字段；内容未知时先问用户。`;
    }

    if (!field.value.trim()) {
      return `字段「${requirement.label}」为空，提交未执行。请先补齐该字段；内容未知时先问用户要填什么。`;
    }
  }

  return null;
}
