/**
 * 「/ 技能」：用户存下来的常用提示词，在输入框开头敲 `/` 唤起，选中后对当前标签页运行。
 *
 * - 提示词技能只存在本机 chrome.storage.local，与记忆无关。
 * - 可直接运行的技能（核对做成后存下的只读程序）存在后台，只在存下它的网站上列出，见 skill-operations.ts。
 * - 技能可带 1–2 个澄清问题：先在侧栏里问，答完把回答填进正文（`{1}`、`{2}`）再发；取消就什么都不发。
 * - 发送走侧栏正常发送路径（由调用方传入），当前页面上下文照常附带。
 */

import { Zap, createElement as icon } from "lucide";
import type { SkillOperationSummary } from "../../../shared/protocol.js";
import { deleteSkillOperation, knownSkillOperations, onSkillOperationsChange, refreshSkillOperations, skillOperationsFor } from "./skill-operations.js";
import { targetWindowId } from "./target-window.js";
import { onSkillPackagesChange, removeSkillPackageConfig, saveSkillPackageConfig, skillPackageConfig } from "./skill-packages.js";
import type { JsonObject, JsonSchema } from "../../../shared/learned-operations.js";

interface PromptSkill {
  id: string;
  name: string;
  emoji?: string;
  body: string;
  /** 0–2 个澄清问题；正文里 `{1}`、`{2}` 换成对应回答，没写占位就附在末尾。 */
  questions?: string[];
}

const PROMPT_SKILLS_KEY = "sideagent_prompt_skills";

const MAX_QUESTIONS = 2;

const DEFAULT_PROMPT_SKILLS: PromptSkill[] = [
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
function fillSkillBody(skill: PromptSkill, answers: string[]): string {
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

/** 网站显示名：去掉协议和 www。 */
function siteLabel(site: string): string {
  try { return new URL(site).host.replace(/^www\./, ""); } catch { return site; }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (cls) node.className = cls;

  if (text != null) node.textContent = text;

  return node;
}

interface OperationField {
  name: string;
  read: () => unknown;
}

function appendOperationFields(form: HTMLElement, schema: JsonSchema, values: JsonObject): OperationField[] {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.entries(schema.properties as Record<string, JsonSchema>) : [];
  return properties.map(([name, fieldSchema]) => {
    const wrap = el("label", "pskill-field");
    wrap.append(el("span", undefined, name));
    const initial = values[name];
    const type = Array.isArray(fieldSchema.type) ? "json" : fieldSchema.type;
    let input: HTMLInputElement | HTMLTextAreaElement;
    if (type === "boolean") {
      input = el("input");
      input.type = "checkbox";
      input.checked = initial === true;
    } else if (type === "string" || type === "number" || type === "integer") {
      input = el("input");
      input.type = type === "string" ? "text" : "number";
      if (type === "integer") input.step = "1";
      input.value = initial == null ? "" : String(initial);
    } else {
      input = el("textarea");
      input.rows = 2;
      input.value = initial === undefined ? "" : JSON.stringify(initial);
      input.placeholder = "JSON";
    }
    input.name = name;
    wrap.append(input);
    form.append(wrap);
    return { name, read: () => {
      if (type === "boolean") return (input as HTMLInputElement).checked;
      if (type === "number" || type === "integer") return input.value === "" ? undefined : Number(input.value);
      if (type === "string") return input.value;
      if (!input.value.trim()) return undefined;
      return JSON.parse(input.value) as unknown;
    } };
  });
}

function operationInputComplete(schema: JsonSchema, input: JsonObject): boolean {
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return required.every(key => input[key] !== undefined);
}

interface SlashSkillsOptions {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  /** 用正常发送路径发出这段文字（会附带当前页面上下文）。 */
  run: (text: string) => void;
  /** 两个直接入口共用：给定技能 ID 和参数，后台直接运行，不变成模型提示词。 */
  runOperation: (operation: SkillOperationSummary, input: JsonObject) => void;
  /** 这条消息是不是最近一个核对做成的任务的请求：是的话「存成技能」可以存成直接运行。 */
  verifiedRequest: (bubble: HTMLElement) => boolean;
}

interface SlashSkills {
  /** 输入框 keydown 先交给技能列表/澄清；返回 true 表示已处理，调用方不要再发送。 */
  handleKeydown: (event: KeyboardEvent) => boolean;
  /** 给已发出的用户消息加「存成技能」。 */
  decorateUserMessage: (bubble: HTMLElement, text: string) => void;
  /** 把一段文字打开技能编辑（结果动作列表用）。 */
  saveFromText: (text: string) => void;
}

export function mountSlashSkills({ composerEl, inputEl, run, runOperation, verifiedRequest }: SlashSkillsOptions): SlashSkills {
  let skills: PromptSkill[] = [];
  /** 用户眼前网页的地址：只列这个网站上能直接运行的技能。 */
  let pageUrl: string | null = null;
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

  type Row = { kind: "skill"; skill: PromptSkill } | { kind: "operation"; operation: SkillOperationSummary } | { kind: "manage" };

  async function syncPage(): Promise<void> {
    const windowId = await targetWindowId().catch(() => undefined);
    const [tab] = await chrome.tabs.query({ active: true, windowId: windowId ?? chrome.windows.WINDOW_ID_CURRENT }).catch(() => []);
    const next = tab?.url ?? null;

    if (next !== pageUrl) { pageUrl = next; refresh(); }
  }

  // 菜单开着时用户切了标签页、或网页跳到别的网站：按眼前的网站重新筛。
  chrome.tabs?.onActivated?.addListener(() => { if (isOpen()) void syncPage(); });
  chrome.tabs?.onUpdated?.addListener((_id, change) => { if (change.url && isOpen()) void syncPage(); });

  onSkillOperationsChange(() => {
    refresh();

    if (!manage.hidden && !editing) renderManageList();
  });

  onSkillPackagesChange(() => {
    refresh();
    if (!manage.hidden && !editing) renderManageList();
  });

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
    const operations = skillOperationsFor(pageUrl).filter((o) => !q || o.name.toLowerCase().includes(q) || o.purpose.toLowerCase().includes(q));
    rows = [...operations.map((operation): Row => ({ kind: "operation", operation })), ...matched.map((skill): Row => ({ kind: "skill", skill })), { kind: "manage" }];
    active = Math.min(active, rows.length - 1);

    if (rows.length > 1 && active === rows.length - 1) active = 0;
    menu.replaceChildren();

    if (rows.length === 1) menu.append(el("div", "pskill-empty", skills.length ? "没有匹配的技能" : "还没有技能"));

    rows.forEach((row, i) => {
      const item = el("div", row.kind === "manage" ? "pskill-item pskill-manage-entry" : row.kind === "operation" ? "pskill-item pskill-op" : "pskill-item");
      item.id = `pskill-opt-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === active));

      if (row.kind === "operation") {
        const glyph = el("span", "pskill-emoji");
        glyph.append(icon(Zap));
        item.append(glyph, el("span", "pskill-name", row.operation.name), el("span", "pskill-badge", "直接运行"), el("span", "pskill-hint", row.operation.purpose));
      } else if (row.kind === "skill") {
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

    if (row.kind === "operation") {
      startOperation(row.operation);
      return;
    }

    start(row.skill);
  }

  function setInput(value: string): void {
    inputEl.value = value;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── 运行与澄清 ───────────────────────────────────────

  function startOperation(operation: SkillOperationSummary): void {
    const configured = skillPackageConfig(operation.id)?.input ?? {};
    if (operationInputComplete(operation.inputSchema, configured)) {
      setInput("");
      runOperation(operation, configured);
      inputEl.focus({ preventScroll: true });
      return;
    }

    setInput("");
    const card = el("form", "pskill-clarify");
    card.dataset.operationForm = "";
    card.setAttribute("aria-label", `运行「${operation.name}」`);
    const title = el("div", "pskill-clarify-title");
    title.append(icon(Zap), document.createTextNode(` ${operation.name}`));
    card.append(title);
    const fields = appendOperationFields(card, operation.inputSchema, configured);
    const error = el("p", "pskill-error");
    error.hidden = true;
    card.append(error);
    const actions = el("div", "pskill-actions");
    const cancel = el("button", "pskill-btn", "取消");
    cancel.type = "button";
    const go = el("button", "pskill-btn primary", "运行");
    go.type = "submit";
    actions.append(cancel, go);
    card.append(actions);
    const finish = (send: boolean): void => {
      if (!send) { card.remove(); clarify = null; inputEl.focus({ preventScroll: true }); return; }
      try {
        const input = Object.fromEntries(fields.map(field => [field.name, field.read()]));
        card.remove();
        clarify = null;
        runOperation(operation, input);
        inputEl.focus({ preventScroll: true });
      } catch {
        error.textContent = "参数里的 JSON 格式不正确。";
        error.hidden = false;
      }
    };
    card.addEventListener("submit", event => { event.preventDefault(); finish(true); });
    cancel.addEventListener("click", () => finish(false));
    card.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); } });
    clarify = card;
    host.insertBefore(card, composerEl);
    card.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  }

  function start(skill: PromptSkill): void {
    const questions = skill.questions ?? [];

    // 不用回答问题的技能：正文放进输入框，用户看过、改过再发。
    if (!questions.length) {
      setInput(fillSkillBody(skill, []));
      inputEl.focus({ preventScroll: true });

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
    refreshSkillOperations();
    manage.hidden = false;
    shade.hidden = false;
    renderManageList();
  }

  function renderManageList(): void {
    editing = false;
    manage.replaceChildren(sheetHead("我的技能"));
    manage.append(el("p", "pskill-note", "在输入框开头输入 /，就能用这些技能。技能只存在这个浏览器里。"));
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

    for (const operation of knownSkillOperations()) {
      const row = el("div", "pskill-row pskill-op-row");
      const glyph = el("span", "pskill-emoji");
      glyph.append(icon(Zap));
      row.append(glyph, el("span", "pskill-name", operation.name), el("span", "pskill-badge", siteLabel(operation.site)));
      const config = el("button", "pskill-btn", "配置");
      config.type = "button";
      config.dataset.packageConfig = "";
      config.addEventListener("click", () => renderOperationConfig(operation));
      const del = el("button", "pskill-btn danger", "删除");
      del.type = "button";
      del.addEventListener("click", () => {
        if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "确认删除";

 return; }

        del.disabled = true;

        if (!deleteSkillOperation(operation.id, ok => {
          if (ok) { void removeSkillPackageConfig(operation.id); return; }
          del.disabled = false;
          del.textContent = "没删成，再试";
        })) {
          del.disabled = false;
          del.textContent = "没连上，再试";
        }
      });
      row.append(config, del);
      list.append(row);
    }

    if (!skills.length && !knownSkillOperations().length) list.append(el("div", "pskill-empty", "还没有技能。也可以在发过的消息上点「存成技能」。"));
    manage.append(list);
    const add = el("button", "pskill-btn primary", "新建技能");
    add.type = "button";
    add.addEventListener("click", () => renderEditor(null));
    manage.append(add);
    (manage.querySelector<HTMLButtonElement>(".pskill-row .pskill-btn") ?? add).focus({ preventScroll: true });
  }

  function renderOperationConfig(operation: SkillOperationSummary): void {
    editing = true;
    manage.replaceChildren(sheetHead(`配置「${operation.name}」`));
    manage.append(el("p", "pskill-note", operation.purpose));
    const form = el("form", "pskill-form");
    form.dataset.packageForm = "";
    const current = skillPackageConfig(operation.id);
    const toggle = (label: string, checked: boolean, attribute: string): HTMLInputElement => {
      const input = el("input");
      input.type = "checkbox";
      input.checked = checked;
      input.dataset[attribute] = "";
      const wrap = el("label", "pskill-check");
      wrap.append(input, el("span", undefined, label));
      form.append(wrap);
      return input;
    };
    const slash = toggle(`在 / 菜单显示「${operation.name}」`, current?.slash ?? true, "packageSlash");
    const page = toggle("在网页上显示按钮", current?.pageButton ?? false, "packagePage");
    form.append(el("p", "pskill-note", "默认参数"));
    const fields = appendOperationFields(form, operation.inputSchema, current?.input ?? {});
    const error = el("p", "pskill-error");
    error.hidden = true;
    form.append(error);
    const actions = el("div", "pskill-actions");
    const back = el("button", "pskill-btn", "返回");
    back.type = "button";
    back.addEventListener("click", renderManageList);
    const saveButton = el("button", "pskill-btn primary", "保存配置");
    saveButton.type = "submit";
    actions.append(back, saveButton);
    form.append(actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      saveButton.disabled = true;
      try {
        const input = Object.fromEntries(fields.map(field => [field.name, field.read()]));
        void saveSkillPackageConfig(operation, { slash: slash.checked, pageButton: page.checked, input }).then(renderManageList).catch((cause: unknown) => {
          saveButton.disabled = false;
          error.textContent = cause instanceof Error ? cause.message : String(cause);
          error.hidden = false;
        });
      } catch {
        saveButton.disabled = false;
        error.textContent = "参数里的 JSON 格式不正确。";
        error.hidden = false;
      }
    });
    manage.append(form);
    slash.focus({ preventScroll: true });
  }

  function renderEditor(skill: PromptSkill | null, prefill?: string, runnable = false): void {
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
    body.placeholder = "要助手对当前页面做什么";
    field("提示词", body);
    const q1 = field("运行前先问（可选）", text(skill?.questions?.[0] ?? "", "例如：预算多少？"));
    const q2 = field("再问一个（可选）", text(skill?.questions?.[1] ?? ""));
    form.append(el("p", "pskill-note", "提示词里写 {1}、{2} 会换成对应回答；没写就把回答附在末尾。"));
    // 刚核对做成的网页任务：可以存成在这个网站上直接运行的技能。助手先用原来的和另一组内容各跑一次，都对才存。
    const direct = el("input");
    direct.type = "checkbox";
    direct.checked = runnable;

    if (runnable) {
      const wrap = el("label", "pskill-check");
      wrap.append(direct, el("span", undefined, "在这个网站上直接运行：助手先验证一次，以后换个词直接重新读页面"));
      form.append(wrap);
    }
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

      if (runnable && direct.checked) {
        closeManage();
        run(`把刚才的做法存成技能，名字叫「${name.value.trim().slice(0, 40)}」`);

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

  function saveFromMessage(text: string, bubble?: HTMLElement): void {
    manage.hidden = false;
    shade.hidden = false;
    renderEditor(null, text, !!bubble && verifiedRequest(bubble));
  }

  // ── 与输入框对接 ─────────────────────────────────────

  inputEl.addEventListener("input", () => {
    if (!inputEl.value.startsWith("/")) { dismissedFor = null; active = 0; }
    else {
      // 用户可能刚切了标签页或网页跳转了：每次输入都按眼前的网站重新筛。
      void syncPage();

      if (inputEl.value === "/") refreshSkillOperations();
    }

    refresh();
  });
  inputEl.addEventListener("blur", () => close());
  inputEl.addEventListener("focus", () => {
    if (inputEl.value.startsWith("/")) { void syncPage(); refreshSkillOperations(); }
    refresh();
  });

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
    btn.title = "把这句话存成技能。以后在输入框输入 /，就能对当前页面再用一次";
    btn.addEventListener("click", (e) => { e.stopPropagation(); saveFromMessage(text, bubble); });
    bubble.append(btn);
  }

  return { handleKeydown, decorateUserMessage, saveFromText: saveFromMessage };
}
