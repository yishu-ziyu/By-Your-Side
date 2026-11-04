import DOMPurify from "dompurify";

const TAGS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q",
  "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
  "u", "ul", "var", "wbr",
];

const ATTRS = ["href", "title", "alt", "src", "width", "height", "align", "colspan", "rowspan", "start", "reversed", "type", "checked", "disabled", "open", "lang", "dir", "datetime", "scope", "class"];

export function sanitizeAnswerHtml(html: string, { images = true }: { images?: boolean } = {}): string {
  const fragment = DOMPurify.sanitize(html, { ALLOWED_TAGS: images ? TAGS : TAGS.filter((tag) => tag !== "img"), ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true });

  for (const el of fragment.querySelectorAll("[class]")) {
    const keep = el.tagName === "CODE" ? [...el.classList].filter((name) => /^language-\S+$/.test(name)) : [];

    if (keep.length) el.className = keep.join(" ");
    else el.removeAttribute("class");
  }

  for (const a of fragment.querySelectorAll("a[href]")) {
    if (!/^(https?:\/\/|mailto:)/i.test((a.getAttribute("href") ?? "").trim())) a.removeAttribute("href");
  }

  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") === "checkbox") input.setAttribute("disabled", "");
    else input.remove();
  }

  for (const img of fragment.querySelectorAll("img")) gateImage(img);

  const template = document.createElement("template");
  template.content.append(fragment);

  return template.innerHTML;
}

const GATE = "data-answer-image";

const GATE_ALT = "data-answer-image-alt";

function gateImage(img: HTMLImageElement): void {
  let url: URL;

  try {
    url = new URL(img.getAttribute("src") ?? "");
  } catch {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const placeholder = img.ownerDocument.createElement("button");
  placeholder.type = "button";
  placeholder.className = "answer-image-gate";
  placeholder.setAttribute(GATE, url.href);
  const alt = img.getAttribute("alt");

  if (alt) placeholder.setAttribute(GATE_ALT, alt);
  placeholder.title = url.href;
  placeholder.textContent = ["图片", url.host, ...(carriesData(url) ? ["带参数"] : []), "点开看"].join(" · ");
  img.replaceWith(placeholder);
}

function carriesData(url: URL): boolean {
  return url.search.length > 1 || url.pathname.length > 24;
}

export function imagePlaceholdersAsText(root: ParentNode): void {
  for (const placeholder of root.querySelectorAll(`[${GATE}]`)) placeholder.replaceWith(placeholder.getAttribute(GATE_ALT) || "[图片]");
}

function loadedImage(placeholder: Element): HTMLImageElement {
  const img = document.createElement("img");
  img.alt = placeholder.getAttribute(GATE_ALT) ?? "";
  img.src = placeholder.getAttribute(GATE)!;

  return img;
}

const opened = new WeakMap<Node, Set<string>>();

export function keepOpenedImages(root: ParentNode, answer: Node): void {
  const urls = opened.get(answer) ?? new Set<string>();
  opened.set(answer, urls);

  for (const placeholder of root.querySelectorAll(`[${GATE}]`)) if (urls.has(placeholder.getAttribute(GATE)!)) placeholder.replaceWith(loadedImage(placeholder));
}

export function openGatedImage(event: MouseEvent): void {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const placeholder = event.target.closest(`button[${GATE}]`);

  if (!placeholder) return;

  for (let node: Node | null = placeholder.parentNode; node; node = node.parentNode) opened.get(node)?.add(placeholder.getAttribute(GATE)!);
  placeholder.replaceWith(loadedImage(placeholder));
}
