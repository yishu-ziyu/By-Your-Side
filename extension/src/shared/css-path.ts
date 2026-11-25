export function cssPathOf(node: Node): string {
  const unique = (selector: string): boolean => document.querySelectorAll(selector).length === 1;
  const parts: string[] = [];

  for (let el = node instanceof Element ? node : node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const tag = el.tagName.toLowerCase();
    const anchor = (el.id && unique(`#${CSS.escape(el.id)}`) ? `#${CSS.escape(el.id)}` : undefined)
      ?? [...el.classList].map((name) => `${tag}.${CSS.escape(name)}`).find(unique);

    if (anchor) return [anchor, ...parts].join(" > ");
    const tagName = el.tagName;
    const same = el.parentElement ? [...el.parentElement.children].filter((child) => child.tagName === tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag);
  }

  return ["body", ...parts].join(" > ");
}
