/** 页面里读到的一栏：敏感栏不带 value；select 表示读的是选中项的文字。 */
export type PageField = { name: string; value?: string; sensitive?: true; truncated?: true; select?: true; /** 下拉框选中项的 value（与可见文字不同时，要写的内容可能是它）。 */ optionValue?: string };

/**
 * 写入之后从网页读回这一栏（页面在 input 事件里改了值，读到的是改过的）。在页面里执行，保持自包含。
 * this 是元素（CDP 按节点调用）；否则按 target 解析，target 为 null 时取当前焦点（type_text）。
 * 密码、验证码、卡号这类栏不读值：type、autocomplete 同 read-element.ts 的 secretField，再加字段名（sensitiveName 是 SENSITIVE_FIELD_NAME 的正则源码）
 * 和「这个页面里曾经是 password」的标记（data-bys-was-password，显示密码后 type 变成 text）。
 */
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
  // SAFETY: 下面按 tagName / isContentEditable 分支收窄后才读 value 或 innerText。
  const field = el as HTMLElement & HTMLInputElement & { selectedOptions: HTMLCollectionOf<HTMLOptionElement> };
  const tag = field.tagName.toLowerCase();
  const by = field.getAttribute("aria-labelledby");
  const name = (field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || ("labels" in field && field.labels?.[0]?.textContent) || field.getAttribute("placeholder") || field.getAttribute("title") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  const editable = tag === "input" || tag === "textarea" || field.isContentEditable;
  // 页面函数不能引用外部模块，所以拆驼峰、换分隔符、转小写在这里内联；SENSITIVE_FIELD_NAME 按这种规整后的文字写。
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
