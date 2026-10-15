/**
 * 长会话的章节：会话空闲时发出的一句话，这一轮用了浏览器工具（读页面、开标签、点、填……）才开一章，
 * 分隔线画在这句话上方；只靠回答、没动工具的追问归进当前这一章。会话的第一句总是第一章。
 * 满 3 章时，对话区上方出现一排章节按钮，点了跳到那一章。
 *
 * 章节只从侧栏回放的历史推出来（实时和重新打开都走同一条回放、同样的顺序），不另存、不调模型，
 * 所以实时在第一步工具出现时画的分隔线，重新打开时会画在同一处。编号和名字都从对话区里现有的分隔线读，
 * 换会话清空对话区时自然归零。
 */
import { isLeadSession } from "../../../shared/protocol.js";
import type { PanelHistoryItem, PanelHistoryServerMessage } from "../relay.js";

/** 「继续原任务」按钮发出的原话：它接着做原来那件事，不算新的一章。 */
const RESUME_TEXT = "继续原任务";

const NAME_MAX = 14;

/** 名字取用户原话：去掉开头的 @ 页面和多余空白，超长截断。名字来自用户输入，只经 textContent 进入页面。 */
export function chapterName(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim().replace(/^(@\S+\s*)+/, "").trim();
  const chars = Array.from(plain);

  if (chars.length === 0) return "新任务";

  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("")}…` : plain;
}

export function mountChapters(messages: HTMLElement, frame: HTMLElement) {
  const row = document.createElement("nav");
  row.className = "chapter-row";
  row.setAttribute("aria-label", "章节");
  row.hidden = true;
  frame.before(row);
  let shown = "";
  /** 开了一轮、还没看到工具步骤的那句话：这一轮用上工具它就开一章，没用就归进当前章。 */
  let pending: { bubble: HTMLElement; text: string } | null = null;

  const dividers = () => [...messages.querySelectorAll<HTMLElement>(":scope > .chapter-divider")];

  const sync = () => {
    if (pending && !pending.bubble.isConnected) pending = null;
    const all = dividers();
    // 只有一章时第一条分隔线没有区分作用，不画。
    all.forEach((d, i) => { d.hidden = i === 0 && all.length < 2; });
    const key = all.map(d => `${d.dataset.chapter}\u0000${d.dataset.name}`).join("\u0001");

    if (key === shown) return;
    shown = key;
    row.hidden = all.length < 3;
    row.replaceChildren(...(row.hidden ? [] : all.map((d) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-jump";
      button.textContent = `${d.dataset.chapter} ${d.dataset.name}`;
      button.title = d.dataset.name ?? "";
      button.onclick = () => {
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        d.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      };

      return button;
    })));
  };

  // 换会话、清空对话区时分隔线跟着消失：按对话区现状重画按钮。
  new MutationObserver(sync).observe(messages, { childList: true });

  const open = (bubble: HTMLElement, text: string) => {
    if (bubble.previousElementSibling?.matches(".chapter-divider")) return;
    const number = dividers().length + 1;
    const name = chapterName(text);
    const divider = document.createElement("div");
    divider.className = "chapter-divider";
    divider.setAttribute("role", "separator");
    divider.dataset.chapter = String(number);
    divider.dataset.name = name;
    const label = document.createElement("span");
    label.textContent = `${number} · ${name}`;
    divider.append(label);
    bubble.before(divider);
    sync();
  };

  return {
    /**
     * 一条用户消息的气泡画好之后调用。idle：这句话发出时会话里没有任务在跑、页面也不在用户手里，
     * 即它开的是新一轮，而不是交给正在做的任务的补充。
     */
    noteUserTurn(bubble: HTMLElement, item: Extract<PanelHistoryItem, { kind: "user" }>, idle: boolean): void {
      if (!idle || item.undelivered || item.text.trim() === RESUME_TEXT) return;

      if (dividers().length === 0) { pending = null; open(bubble, item.text); return; }
      pending = { bubble, text: item.text };
    },

    /** 回放到一条服务端消息时调用：这一轮第一次用工具就给开这一轮的那句话开章；主任务结束后不再等。 */
    noteServer(msg: PanelHistoryServerMessage): void {
      if (msg.type !== "agent_event") return;

      if (msg.event.kind === "tool_start" && pending) {
        const { bubble, text } = pending;
        pending = null;

        if (bubble.isConnected) open(bubble, text);
      }
      else if (msg.event.kind === "agent_end" && isLeadSession(msg.sessionId)) pending = null;
    },
  };
}
