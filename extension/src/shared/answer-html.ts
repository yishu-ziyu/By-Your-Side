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

  const template = document.createElement("template");
  template.content.append(fragment);

  return template.innerHTML;
}
