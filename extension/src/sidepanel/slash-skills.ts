/**
 * #51 「/ 技能」：用户存下来的常用提示词，在输入框开头敲 `/` 唤起，选中后对当前标签页运行。
 *
 * - 只存在本机 chrome.storage.local，与记忆、旧的操作技能无关。
 * - 技能可带 1–2 个澄清问题：先在侧栏里问，答完把回答填进正文（`{1}`、`{2}`）再发；取消就什么都不发。
 * - 发送走侧栏正常发送路径（由调用方传入），当前页面上下文照常附带。
 */

export interface PromptSkill {
  id: string;
  name: string;
  emoji?: string;
  body: string;
  /** 0–2 个澄清问题；正文里 `{1}`、`{2}` 换成对应回答，没写占位就附在末尾。 */
  questions?: string[];
}

export const PROMPT_SKILLS_KEY = "sideagent_prompt_skills";

const MAX_QUESTIONS = 2;

export const DEFAULT_PROMPT_SKILLS: PromptSkill[] = [
  { id: "default-summary", emoji: "📝", name: "概括这页", body: "请概括当前页面的要点：先用一句话说结论，再列 3–5 条关键信息。" },
  {
    id: "default-key-data", emoji: "📊", name: "找出关键数据",
    body: "找出当前页面里的关键数据（数字、日期、价格、指标），整理成表格并说明每条在页面上的出处。重点关注：{1}",
    questions: ["你最关心哪类数据？（可留空）"],
  },
  {
    id: "default-plain", emoji: "💬", name: "用大白话解释",
    body: "用大白话解释当前页面在讲什么，就当我是{1}。少用术语，必要时打个比方。",
    questions: ["解释给谁听？（例如：完全外行、中学生）"],
  },
];

/** 把澄清回答填进正文；空回答记作「不限」，正文里没有占位的回答附在末尾。 */
export function fillSkillBody(skill: PromptSkill, answers: string[]): string {
  let body = skill.body;
  const extra: string[] = [];

  (skill.questions ?? []).forEach((question, i) => {
    const answer = answers[i]?.trim() || "不限";
    const slot = `{${i + 1}}`;

    if (body.includes(slot)) body = body.split(slot).join(answer);
    else extra.push(`${question.replace(/[（(].*?[)）]\s*$/, "").trim()}：${answer}`);
  });

  return extra.length ? `${body.trim()}\n${extra.join("\n")}` : body.trim();
}

/** 存储里的一条技能：字段类型还没核对。 */
interface StoredSkill { id?: unknown; name?: unknown; emoji?: unknown; body?: unknown; questions?: unknown }

/** 存储里的列表项：JSON 能出现的任何值，坏数据在 sanitize 里逐条丢弃。 */
type StoredItem = StoredSkill | string | number | boolean | null | undefined;

const isString = (v: unknown): v is string => typeof v === "string";

const isStoredList = (v: unknown): v is StoredItem[] => Array.isArray(v);

const isStoredSkill = (item: StoredItem): item is StoredSkill => !!item && typeof item === "object";

function sanitize(raw: StoredItem[]): PromptSkill[] {
  return raw.flatMap((item): PromptSkill[] => {
    if (!isStoredSkill(item)) return [];
    const { id, name, body, emoji } = item;

    if (!isString(id) || !isString(name) || !isString(body)) return [];
    const questions = Array.isArray(item.questions) ? item.questions.filter((q): q is string => isString(q) && q.trim() !== "").slice(0, MAX_QUESTIONS) : [];

    return [{ id, name, body, emoji: isString(emoji) && emoji ? emoji : undefined, questions: questions.length ? questions : undefined }];
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (cls) node.className = cls;

  if (text != null) node.textContent = text;

  return node;
}

export interface SlashSkillsOptions {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  /** 用正常发送路径发出这段文字（会附带当前页面上下文）。 */
  run: (text: string) => void;
}

export interface SlashSkills {
  /** 输入框 keydown 先交给技能列表/澄清；返回 true 表示已处理，调用方不要再发送。 */
  handleKeydown: (event: KeyboardEvent) => boolean;
  /** 给已发出的用户消息加「存成技能」。 */
  decorateUserMessage: (bubble: HTMLElement, text: string) => void;
}

export function mountSlashSkills({ composerEl, inputEl, run }: SlashSkillsOptions): SlashSkills {
  let skills: PromptSkill[] = [];
  let loaded = false;
  let active = 0;
  /** 用户按 Esc 关掉列表后，同一段输入不再自动弹出。 */
  let dismissedFor: string | null = null;
  let clarify: HTMLElement | null = null;

  const host = composerEl.parentElement ?? composerEl;

  const menu = el("div", "pskill-menu");
  menu.id = "pskill-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "我的技能");
  menu.hidden = true;
  host.insertBefore(menu, composerEl);
  inputEl.setAttribute("aria-controls", menu.id);

  const save = (next: PromptSkill[]): void => {
    skills = next;
    void chrome.storage?.local?.set({ [PROMPT_SKILLS_KEY]: next });
  };

  void chrome.storage?.local?.get(PROMPT_SKILLS_KEY).then((stored) => {
    const raw = stored[PROMPT_SKILLS_KEY];
    const parsed = isStoredList(raw) ? sanitize(raw) : null;
    loaded = true;

    if (parsed) skills = parsed;
    else save(DEFAULT_PROMPT_SKILLS.map((s) => ({ ...s })));
    refresh();
  }).catch(() => { loaded = true; skills = DEFAULT_PROMPT_SKILLS.map((s) => ({ ...s })); });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !(PROMPT_SKILLS_KEY in changes)) return;
    const next = changes[PROMPT_SKILLS_KEY].newValue;
    skills = isStoredList(next) ? sanitize(next) : [];
    refresh();

    if (!manage.hidden && !editing) renderManageList();
  });

  // ── 列表 ─────────────────────────────────────────────

  type Row = { kind: "skill"; skill: PromptSkill } | { kind: "manage" };

  let rows: Row[] = [];

  function query(): string | null {
    const value = inputEl.value;

    if (!value.startsWith("/") || value.includes("\n")) return null;

    return value.slice(1).trim().toLowerCase();
  }

  function isOpen(): boolean { return !menu.hidden; }

  function close(): void {
    menu.hidden = true;
    inputEl.removeAttribute("aria-activedescendant");
    inputEl.setAttribute("aria-expanded", "false");
  }

  function refresh(): void {
    const q = query();

    if (q == null || !loaded || clarify || dismissedFor === inputEl.value) { close();

 return; }

    if (dismissedFor !== null) dismissedFor = null;
    const matched = skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q));
    rows = [...matched.map((skill): Row => ({ kind: "skill", skill })), { kind: "manage" }];
    active = Math.min(active, rows.length - 1);

    if (matched.length && active === rows.length - 1) active = 0;
    menu.replaceChildren();

    if (!matched.length) menu.append(el("div", "pskill-empty", skills.length ? "没有匹配的技能" : "还没有技能"));

    rows.forEach((row, i) => {
      const item = el("div", row.kind === "manage" ? "pskill-item pskill-manage-entry" : "pskill-item");
      item.id = `pskill-opt-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === active));

      if (row.kind === "skill") {
        item.append(el("span", "pskill-emoji", row.skill.emoji ?? "⚡"), el("span", "pskill-name", row.skill.name));
        const hint = row.skill.body.replace(/\{\d\}/g, "…").replace(/\s+/g, " ");
        item.append(el("span", "pskill-hint", hint));
      } else {
        item.append(el("span", "pskill-emoji", "⚙"), el("span", "pskill-name", "管理技能"));
      }

      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => { active = i; pick(); });
      item.addEventListener("mousemove", () => { if (active !== i) { active = i; highlight(); } });
      menu.append(item);
    });

    menu.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
    highlight();
  }

  function highlight(): void {
    menu.querySelectorAll<HTMLElement>(".pskill-item").forEach((item, i) => {
      item.setAttribute("aria-selected", String(i === active));

      if (i === active) item.scrollIntoView({ block: "nearest" });
    });
    inputEl.setAttribute("aria-activedescendant", `pskill-opt-${active}`);
  }

  function pick(): void {
    const row = rows[active];
    close();

    if (!row) return;

    if (row.kind === "manage") { openManage();

 return; }

    start(row.skill);
  }

  function setInput(value: string): void {
    inputEl.value = value;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── 运行与澄清 ───────────────────────────────────────

  function start(skill: PromptSkill): void {
    const questions = skill.questions ?? [];

    if (!questions.length) {
      setInput("");
      run(fillSkillBody(skill, []));

      return;
    }

    setInput("");
    const card = el("form", "pskill-clarify");
    card.setAttribute("aria-label", `运行「${skill.name}」前先确认`);
    card.append(el("div", "pskill-clarify-title", `${skill.emoji ?? "⚡"} ${skill.name}`));

    const fields = questions.map((question, i) => {
      const label = el("label", "pskill-field");
      label.append(el("span", undefined, question));
      const field = el("input");
      field.type = "text";
      field.name = `q${i + 1}`;
      label.append(field);
      card.append(label);

      return field;
    });

    const actions = el("div", "pskill-actions");
    const cancel = el("button", "pskill-btn", "取消");
    cancel.type = "button";
    const go = el("button", "pskill-btn primary", "开始");
    go.type = "submit";
    actions.append(cancel, go);
    card.append(actions);

    const finish = (send: boolean): void => {
      card.remove();
      clarify = null;

      if (send) run(fillSkillBody(skill, fields.map((f) => f.value)));
      inputEl.focus({ preventScroll: true });
    };

    card.addEventListener("submit", (e) => { e.preventDefault(); finish(true); });
    cancel.addEventListener("click", () => finish(false));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });

    clarify = card;
    host.insertBefore(card, composerEl);
    fields[0]?.focus({ preventScroll: true });
  }

  // ── 管理：新建 / 改名 / 编辑 / 删除 ──────────────────

  const shade = el("button", "pskill-shade");
  shade.type = "button";
  shade.setAttribute("aria-label", "关闭技能管理");
  shade.hidden = true;
  const manage = el("section", "pskill-sheet");
  manage.setAttribute("role", "dialog");
  manage.setAttribute("aria-label", "我的技能");
  manage.hidden = true;
  document.body.append(shade, manage);
  let editing = false;

  function closeManage(): void {
    manage.hidden = true;
    shade.hidden = true;
    editing = false;
    inputEl.focus({ preventScroll: true });
  }

  shade.addEventListener("click", closeManage);
  manage.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeManage(); }
  });

  function sheetHead(title: string): HTMLElement {
    const head = el("div", "pskill-sheet-head");
    head.append(el("h2", undefined, title));
    const x = el("button", "pskill-btn", "关闭");
    x.type = "button";
    x.addEventListener("click", closeManage);
    head.append(x);

    return head;
  }

  function openManage(): void {
    setInput("");
    manage.hidden = false;
    shade.hidden = false;
    renderManageList();
  }

  function renderManageList(): void {
    editing = false;
    manage.replaceChildren(sheetHead("我的技能"));
    manage.append(el("p", "pskill-note", "在输入框开头敲 / 就能调出这些技能，对当前标签页运行。只存在这台电脑上。"));
    const list = el("div", "pskill-list");

    for (const skill of skills) {
      const row = el("div", "pskill-row");
      row.append(el("span", "pskill-emoji", skill.emoji ?? "⚡"), el("span", "pskill-name", skill.name));
      const edit = el("button", "pskill-btn", "编辑");
      edit.type = "button";
      edit.addEventListener("click", () => renderEditor(skill));
      const del = el("button", "pskill-btn danger", "删除");
      del.type = "button";
      del.addEventListener("click", () => {
        if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "确认删除";

 return; }

        save(skills.filter((s) => s.id !== skill.id));
        renderManageList();
      });
      row.append(edit, del);
      list.append(row);
    }

    if (!skills.length) list.append(el("div", "pskill-empty", "还没有技能。也可以在发过的消息上点「存成技能」。"));
    manage.append(list);
    const add = el("button", "pskill-btn primary", "新建技能");
    add.type = "button";
    add.addEventListener("click", () => renderEditor(null));
    manage.append(add);
    (manage.querySelector<HTMLButtonElement>(".pskill-row .pskill-btn") ?? add).focus({ preventScroll: true });
  }

  function renderEditor(skill: PromptSkill | null, prefill?: string): void {
    editing = true;
    manage.replaceChildren(sheetHead(skill ? "编辑技能" : "新建技能"));
    const form = el("form", "pskill-form");

    const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement): HTMLInputElement | HTMLTextAreaElement => {
      const wrap = el("label", "pskill-field");
      wrap.append(el("span", undefined, label), input);
      form.append(wrap);

      return input;
    };

    const text = (value: string, placeholder = ""): HTMLInputElement => {
      const input = el("input");
      input.type = "text";
      input.value = value;
      input.placeholder = placeholder;

      return input;
    };

    const emoji = text(skill?.emoji ?? "", "⚡");
    field("图标（可选）", emoji);
    emoji.maxLength = 4;
    const seed = prefill?.trim() ?? "";
    const name = field("名字", text(skill?.name ?? seed.replace(/\s+/g, " ").slice(0, 12), "例如：对比价格"));
    const body = el("textarea");
    body.rows = 4;
    body.value = skill?.body ?? seed;
    body.placeholder = "要 AI 对当前页面做什么";
    field("提示词", body);
    const q1 = field("运行前先问（可选）", text(skill?.questions?.[0] ?? "", "例如：预算多少？"));
    const q2 = field("再问一个（可选）", text(skill?.questions?.[1] ?? ""));
    form.append(el("p", "pskill-note", "提示词里写 {1}、{2} 会换成对应回答；没写就把回答附在末尾。"));
    const error = el("p", "pskill-error");
    error.hidden = true;
    form.append(error);

    const actions = el("div", "pskill-actions");
    const back = el("button", "pskill-btn", "返回");
    back.type = "button";
    back.addEventListener("click", renderManageList);
    const ok = el("button", "pskill-btn primary", "保存");
    ok.type = "submit";
    actions.append(back, ok);
    form.append(actions);

    form.addEventListener("submit", (e) => {
      e.preventDefault();

      if (!name.value.trim() || !body.value.trim()) {
        error.textContent = "名字和提示词都要填。";
        error.hidden = false;

        return;
      }

      const questions = [q1.value.trim(), q2.value.trim()].filter(Boolean);

      const next: PromptSkill = {
        id: skill?.id ?? crypto.randomUUID(),
        name: name.value.trim(),
        emoji: emoji.value.trim() || undefined,
        body: body.value.trim(),
        questions: questions.length ? questions : undefined,
      };

      save(skill ? skills.map((s) => (s.id === skill.id ? next : s)) : [...skills, next]);
      renderManageList();
    });

    manage.append(form);
    name.focus({ preventScroll: true });
  }

  function saveFromMessage(text: string): void {
    manage.hidden = false;
    shade.hidden = false;
    renderEditor(null, text);
  }

  // ── 与输入框对接 ─────────────────────────────────────

  inputEl.addEventListener("input", () => {
    if (!inputEl.value.startsWith("/")) { dismissedFor = null; active = 0; }

    refresh();
  });
  inputEl.addEventListener("blur", () => close());
  inputEl.addEventListener("focus", () => refresh());

  function handleKeydown(e: KeyboardEvent): boolean {
    if (!isOpen() || e.isComposing) return false;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      highlight();

      return true;
    }

    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick();

      return true;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissedFor = inputEl.value;
      close();

      return true;
    }

    return false;
  }

  function decorateUserMessage(bubble: HTMLElement, text: string): void {
    if (!text.trim() || bubble.querySelector(".pskill-save")) return;
    const btn = el("button", "pskill-save", "存成技能");
    btn.type = "button";
    btn.title = "把这句话存成技能，以后在输入框敲 / 就能对当前页面再跑一次";
    btn.addEventListener("click", (e) => { e.stopPropagation(); saveFromMessage(text); });
    bubble.append(btn);
  }

  return { handleKeydown, decorateUserMessage };
}
