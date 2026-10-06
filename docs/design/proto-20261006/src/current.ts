/** 对照用：生产 sidepanel 现状。模板逐字取自 main.ts 的 app.innerHTML，配生产 styles.css，消息用同一场景的假数据。 */
import { createElement as icon, Ellipsis, ChevronDown, ChevronRight, Copy, PenLine } from "lucide";
import DOMPurify from "dompurify";
import { renderMarkdownHtml } from "./vendor/markdown.js";
import TEMPLATE from "./current-template.html";

const app = document.getElementById("app")!;
app.innerHTML = TEMPLATE;
document.getElementById("header-more")!.append(icon(Ellipsis));
const sw = document.getElementById("conversation-switcher")!;
sw.innerHTML = `<span class="conversation-title">回复招聘邮件</span>`; sw.append(icon(ChevronDown));
document.getElementById("status-pill")!.classList.add("status-on");
document.getElementById("tab-icon-sq")!.textContent = "M";
document.getElementById("tab-title-text")!.textContent = "Product Designer 职位 —— 想约你聊聊 - Gmail";
(document.querySelector(".morph-icon-send") as HTMLElement).innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>`;
const msgs = document.getElementById("messages")!;
const user = document.createElement("div"); user.className = "msg user"; user.textContent = "帮我回这封招聘邮件，约下周二或周三下午聊，语气别太正式。";
const run = document.createElement("details"); run.className = "run-steps done";
const sum = document.createElement("summary");
const ic = document.createElement("span"); ic.className = "run-act-icon"; ic.append(icon(PenLine));
const title = document.createElement("span"); title.className = "run-title"; title.innerHTML = `<span class="act-verb">填写了</span> <span class="act-object">「回复草稿」</span>`;
const ch = document.createElement("span"); ch.className = "run-chevron"; ch.append(icon(ChevronRight));
sum.append(ic, title, ch); run.append(sum);
const ans = document.createElement("div"); ans.className = "msg assistant markdown answer-latest";
ans.innerHTML = DOMPurify.sanitize(renderMarkdownHtml(`我写好了草稿，已经填进 Gmail 回复框，**还没发送**：

> Hi Lena，谢谢来信，这个方向我很感兴趣。下周二（10/13）14:00–17:00，或周三（10/14）15:00 以后都可以，30 分钟视频就好。
>
> Mike

1. **时间**：只给了日历上空着的两段，避开周三上午的评审。
2. **语气**：去掉了「非常荣幸」这类客套，保留一句感谢。`));
const acts = document.createElement("div"); acts.className = "answer-actions";
const copy = document.createElement("button"); copy.append(icon(Copy));
const src = document.createElement("button"); src.className = "answer-sources-btn"; src.innerHTML = `<span class="answer-source-glyph">M</span><span class="answer-source-glyph">日</span>来源 · 2 条记忆`;
const t = document.createElement("span"); t.className = "answer-time"; t.textContent = "7 秒";
acts.append(copy, src, t); ans.append(acts);
msgs.append(user, run, ans);
