/**
 * A8：对一条结果做什么。主动作留在回答末尾；其余收进动作列表。
 * Chrome 的 Ctrl/⌘K 会抢去地址栏搜索，所以用 Ctrl/⌘+Shift+K，和 / 技能菜单分开。
 */
import { answerPlainText, listResultActions, runPrimaryAction, showCopied, showFailed, type ResultAction } from "./answer-actions.js";
import { uiEvent } from "./ui-trace.js";
import { reducedMotion } from "./branch-graph.js";

interface AnswerCommand {
  handleKeydown: (event: KeyboardEvent) => boolean;
  open: (answer?: HTMLElement | null) => void;
  close: () => void;
  isOpen: () => boolean;
  syncHint: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function mountAnswerCommand(opts: {
  inputEl: HTMLTextAreaElement;
  latestAnswer: () => HTMLElement | null;
  saveSkill: (text: string) => void;
  continueInNew: (text: string) => void;
}): AnswerCommand {
  const menu = el("div", "answer-command-menu");
  menu.id = "answer-command-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "对这条结果做什么");
  menu.hidden = true;
  const search = el("input", "answer-command-search");
  search.type = "search";
  search.placeholder = "筛选动作…";
  search.setAttribute("aria-label", "筛选动作");
  const list = el("div", "answer-command-list");
  menu.append(search, list);
  document.body.append(menu);

  let items: ResultAction[] = [];
  let shown: ResultAction[] = [];
  let active = 0;
  let target: HTMLElement | null = null;

  const isOpen = (): boolean => !menu.hidden;

  const close = (): void => {
    if (menu.hidden) return;
    if (!reducedMotion()) {
      menu.classList.add("answer-command-out");
      window.setTimeout(() => { menu.classList.remove("answer-command-out"); menu.hidden = true; }, 90);
    } else menu.hidden = true;
    search.value = "";
    target = null;
    opts.inputEl.focus({ preventScroll: true });
  };

  const highlight = (): void => {
    list.querySelectorAll<HTMLElement>(".answer-command-item").forEach((row, i) => {
      row.setAttribute("aria-selected", String(i === active));
      if (i === active) row.scrollIntoView({ block: "nearest" });
    });
  };

  const paint = (): void => {
    const q = search.value.trim().toLowerCase();
    shown = items.filter((a) => !q || a.label.toLowerCase().includes(q) || a.id.includes(q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren();
    if (!shown.length) list.append(el("div", "answer-command-empty", "没有匹配的动作"));
    shown.forEach((action, i) => {
      const row = el("div", "answer-command-item");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === active));
      row.append(el("span", "answer-command-name", action.label));
      if (action.shortcut) row.append(el("kbd", "answer-command-key", action.shortcut));
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => { void run(action); });
      row.addEventListener("mousemove", () => { if (active !== i) { active = i; highlight(); } });
      list.append(row);
    });
    highlight();
  };

  async function run(action: ResultAction): Promise<void> {
    const answer = target;
    close();
    if (!answer) return;
    uiEvent("ui_answer_action", { action: action.id, from: "menu" });
      try {
      await action.run(answer);
      if (action.id.startsWith("copy")) showCopied(answer);
    } catch {
      showFailed(answer);
    }
  }

  /**
   * 产生这条回答的用户原话：往回跳过同一轮里助手的过渡句，收集连着的用户消息（中途补的话也算），按发出顺序。
   * 技能存的是请求；存回答全文的话，下次运行就是把旧回答当新请求发出去。
   */
  const requestOf = (answer: HTMLElement): string => {
    const said: string[] = [];

    for (let node = answer.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.matches(".msg.user")) {
        const text = node.querySelector(".user-msg-text")?.textContent?.trim();

        if (text) said.unshift(text);
      } else if (said.length && node.matches(".msg.assistant")) break;
    }

    return said.join("\n");
  };

  const extras = (answer: HTMLElement): ResultAction[] => [
    {
      id: "continue",
      label: "接着做",
      run: async () => { opts.inputEl.focus({ preventScroll: true }); },
    },
    {
      id: "new-session",
      label: "作为新会话继续",
      run: async () => {
        const body = answer.cloneNode(true) as HTMLElement;
        body.querySelectorAll(".answer-actions,.answer-panel,.answer-command-menu").forEach((n) => n.remove());
        opts.continueInNew(answerPlainText(body).slice(0, 400));
      },
    },
    ...(requestOf(answer) ? [{
      id: "save-skill",
      label: "存成技能",
      run: async () => { opts.saveSkill(requestOf(answer)); },
    }] : []),
  ];

  const open = (answer?: HTMLElement | null): void => {
    const latest = answer ?? opts.latestAnswer();
    if (!latest) return;
    target = latest;
    items = [...listResultActions(latest), ...extras(latest)];
    menu.hidden = false;
    paint();
    search.focus({ preventScroll: true });
  };

  search.addEventListener("input", () => { active = 0; paint(); });
  search.addEventListener("keydown", (e) => {
    if (handleListKey(e)) e.stopPropagation();
  });

  document.addEventListener("mousedown", (e) => {
    if (!isOpen()) return;
    if (menu.contains(e.target as Node)) return;
    close();
  });

  function handleListKey(e: KeyboardEvent): boolean {
    if (!isOpen() || e.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return true;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      highlight();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const action = shown[active];
      if (action) void run(action);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  }

  const isCommandChord = (e: KeyboardEvent): boolean =>
    (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "k";

  function handleKeydown(e: KeyboardEvent): boolean {
    if (e.isComposing || e.defaultPrevented) return false;
    if (isCommandChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen()) close();
      else open();
      return true;
    }
    if (isOpen() && document.activeElement === search) return handleListKey(e);
    if (e.key === "Enter" && !e.shiftKey && !opts.inputEl.value.trim() && document.activeElement === opts.inputEl) {
      const latest = opts.latestAnswer();
      if (latest && !isOpen()) {
        e.preventDefault();
        void runPrimaryAction(latest, { keyboard: true });
        return true;
      }
    }
    return false;
  }

  const syncHint = (): void => {
    const latest = opts.latestAnswer();
    const hint = latest?.querySelector<HTMLElement>(".answer-enter-hint");
    if (!hint) return;
    const show = !opts.inputEl.value.trim() && document.hasFocus();
    hint.hidden = !show;
  };

  opts.inputEl.addEventListener("input", syncHint);
  document.addEventListener("focusin", syncHint);

  return { handleKeydown, open, close, isOpen, syncHint };
}

