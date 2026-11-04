export type PageField = { name: string; value?: string; sensitive?: true; truncated?: true; select?: true;  optionValue?: string };

export function readFieldInPage(this: unknown, target: string | null, max: number, sensitiveName: string): PageField | null {
  let el: Element | null | undefined = this instanceof Element ? this : null;

  if (!el && target) el = window.__sideagent?.dom?.resolve(target);

  if (!el && !target) {
    el = document.activeElement;

    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  }

  if (!el) return null;
  const host = (el.getRootNode?.() as ShadowRoot | undefined)?.host;

  if (host?.tagName === "INPUT" && (host as HTMLInputElement).type === "time") el = host;
  const field = el as HTMLElement & HTMLInputElement & { selectedOptions: HTMLCollectionOf<HTMLOptionElement> };
  const tag = field.tagName.toLowerCase();
  const by = field.getAttribute("aria-labelledby");
  const name = (field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || ("labels" in field && field.labels?.[0]?.textContent) || field.getAttribute("placeholder") || field.getAttribute("title") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  const editable = tag === "input" || tag === "textarea" || field.isContentEditable;
  const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  const sensitive = editable && ((tag === "input" && (field.type === "password" || field.hasAttribute("data-bys-was-password")))
    || /one-time-code|cc-(number|csc|exp)/i.test(String(field.getAttribute("autocomplete") ?? ""))
    || new RegExp(sensitiveName, "i").test([field.getAttribute("name"), field.id, name, field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title")].map((part) => normalize(String(part ?? ""))).join(" ")));

  if (tag === "input" && field.type === "password") field.setAttribute("data-bys-was-password", "");

  if (sensitive) return { name, sensitive: true };
  let value: string;
  let optionValue: string | undefined;

  if (tag === "select") {
    value = [...field.selectedOptions].map((option) => option.text.trim()).join(", ");
    optionValue = [...field.selectedOptions].map((option) => option.value).join(", ");
  }
  else if (tag === "input" || tag === "textarea") value = String(field.value ?? "");
  else if (field.isContentEditable) value = field.innerText;
  else return null;

  return { name, value: value.length > max ? value.slice(0, max) : value, ...(value.length > max ? { truncated: true as const } : {}), ...(tag === "select" ? { select: true as const, optionValue } : {}) };
}
