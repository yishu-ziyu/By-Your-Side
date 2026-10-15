import type { ModelOption } from "../../../shared/protocol.js";
import { displayName, filterModels, groupModelsByProvider, providerLabel } from "./models.js";

/**
 * 输入框左下角「模型 · 快」：一个菜单里选模型、切「快 / 深入」，更多模型在同一个菜单里滑进第二层。
 * 做法跟 Claude 和 ChatGPT 发送键旁的模型菜单一致（docs/evals/20261015-model-menu.md）。
 * 选模型只发 set_model，等宿主回 model_info 才改开关上的名字；「快 / 深入」存在本机、对所有会话生效。
 */
const LEVEL: Record<string, string> = { off: "关", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };

const KEY = "sideagent.thinkingDeep";

const RECENT_KEY = "sideagent.recentModels";

/** 目录不超过这个数就全放第一层，不给「更多模型」。 */
const FIRST_LEVEL_MAX = 5;

/** 第一层至少放几个：最近用过的和精选不够时，用当前模型同一账号下的补上。 */
const FIRST_LEVEL_MIN = 3;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");

    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

const svg = (path: string, size = 16, stroke = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const CHEVRON = svg('<path d="m6 15 6-6 6 6"/>', 10, 2.6);

const CHECK = svg('<path d="M20 6 9 17l-5-5"/>', 16, 2.2);

export interface ModelMenu {
  /** hello_ok / model_info：缺省的字段保留现值。 */
  update(model: string | undefined, models: ModelOption[] | undefined): void;
  /** 会话切换或断线：回到不知道当前模型的状态。 */
  reset(): void;
  /** 连上宿主后把选过的强度告诉它（新开的宿主不记得）。 */
  connected(): void;
}

export function mountModelMenu(options: { composer: HTMLElement; after: HTMLElement; sendThinking: (deep: boolean) => void; setModel: (id: string) => void }): ModelMenu {
  const chip = document.createElement("button");
  chip.id = "think-chip";
  chip.type = "button";
  chip.hidden = true;
  chip.title = "模型与思考强度";
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  options.after.after(chip);

  const menu = document.createElement("div");
  menu.id = "think-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "模型与思考");
  menu.tabIndex = -1;
  menu.inert = true;
  menu.innerHTML = `<div class="mm-views"><div class="mm-view mm-main"></div><div class="mm-view mm-all">
    <div class="mm-head"><button type="button" class="mm-back" aria-label="返回">${svg('<path d="m15 18-6-6 6-6"/>')}</button>
    <label class="mm-search">${svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 14)}<input type="text" placeholder="搜索全部模型" aria-label="搜索全部模型" autocomplete="off" spellcheck="false"></label></div>
    <div class="mm-list" role="group" aria-label="全部模型"></div></div></div>`;
  options.composer.append(menu);

  const main = menu.querySelector<HTMLElement>(".mm-main")!;
  const all = menu.querySelector<HTMLElement>(".mm-all")!;
  const list = menu.querySelector<HTMLElement>(".mm-list")!;
  const search = menu.querySelector<HTMLInputElement>(".mm-search input")!;

  let chosen: boolean | undefined;

  try {
    const saved = localStorage.getItem(KEY);
    chosen = saved === null ? undefined : saved === "1";
  } catch { /* 读不到就按没选过 */ }

  let current: string | undefined;
  let models: ModelOption[] = [];
  let view: "main" | "all" = "main";

  const currentOption = () => models.find((m) => m.id === current);
  const deep = () => chosen ?? false;

  let recent = readRecent();

  /** 第一层：当前模型、最近用过的、精选；不够就用同一账号下的补。目录小就全放第一层。 */
  const firstLevel = () => {
    if (models.length <= FIRST_LEVEL_MAX) return models;
    const byId = new Map(models.map((m) => [m.id, m]));
    const provider = currentOption()?.provider;
    const ids = new Set([current, ...recent, ...models.filter((m) => m.featured === true).map((m) => m.id)].filter((id): id is string => Boolean(id && byId.has(id))));

    for (const m of models) {
      if (ids.size >= FIRST_LEVEL_MIN) break;

      if (m.provider === provider) ids.add(m.id);
    }

    return [...ids].slice(0, FIRST_LEVEL_MAX).map((id) => byId.get(id)!);
  };

  const row = (m: ModelOption, note?: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mm-row";
    button.dataset.model = m.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(m.id === current));
    button.innerHTML = `<span class="mm-name"></span><span class="mm-desc"></span><span class="mm-check">${CHECK}</span>`;
    button.querySelector(".mm-name")!.textContent = displayName(m);
    button.querySelector(".mm-desc")!.textContent = note ?? providerLabel(m.provider);

    return button;
  };

  const paintChip = (changed?: "name" | "level") => {
    const option = currentOption();
    chip.hidden = !current;

    if (!current) return;
    const name = option ? displayName(option) : current.slice(current.lastIndexOf("/") + 1);
    const level = option?.thinking ? (deep() ? "深入" : "快") : "";
    chip.innerHTML = `<span class="think-model"></span>${level ? `<span class="think-sep">·</span><span class="think-level"></span>` : ""}${CHEVRON}`;
    chip.querySelector(".think-model")!.textContent = name;
    // 窄侧栏只露图标，全名靠悬停提示和读屏名字说出来。
    chip.title = `模型：${name}${level ? ` · ${level}` : ""}`;
    chip.setAttribute("aria-label", chip.title);

    if (level) chip.querySelector(".think-level")!.textContent = level;
    chip.classList.toggle("deep", Boolean(level) && deep());

    if (changed) chip.querySelector(changed === "name" ? ".think-model" : ".think-level")?.classList.add("think-swap");
  };

  const effortNote = (thinking: { fast: string; deep: string }) => deep() ? `${LEVEL[thinking.deep] ?? thinking.deep}档，想得更全` : `${LEVEL[thinking.fast] ?? thinking.fast}档，日常操作`;

  const paintMain = () => {
    const option = currentOption();
    const first = firstLevel();
    // 都是同一个账号时不逐行写账号，只在混着几个账号时写清每个走哪个。
    const mixed = new Set(first.map((m) => m.provider)).size > 1;
    const rows = models.length ? first.map((m) => { const r = row(m); if (!mixed) r.querySelector(".mm-desc")!.remove(); return r; }) : current ? [row({ id: current, name: "", modelId: current.slice(current.lastIndexOf("/") + 1), provider: current.split("/")[0] ?? "" }, "还没读到模型列表，现在不能切换")] : [];
    const parts: HTMLElement[] = [...rows];

    if (option?.thinking) {
      const effort = document.createElement("div");
      effort.className = "mm-effort";
      effort.innerHTML = `<span class="mm-effort-label">思考<small></small></span>
        <span class="mm-seg" role="radiogroup" aria-label="思考强度"><span class="mm-thumb"></span><button type="button" role="radio" data-deep="0">快</button><button type="button" role="radio" data-deep="1">深入</button></span>`;
      effort.querySelector("small")!.textContent = effortNote(option.thinking);
      effort.querySelector(".mm-seg")!.classList.toggle("deep", deep());
      effort.querySelectorAll<HTMLButtonElement>("[data-deep]").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.deep === "1") === deep())));
      parts.push(document.createElement("hr"), effort);
    }

    if (models.length > firstLevel().length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "mm-row mm-more";
      more.innerHTML = `<span class="mm-name">更多模型</span><span class="mm-chev">${svg('<path d="m9 18 6-6-6-6"/>', 14)}</span>`;
      parts.push(document.createElement("hr"), more);
    }

    main.replaceChildren(...parts);
  };

  const paintAll = () => {
    const hits = filterModels(models, search.value, false);

    if (!hits.length) {
      const none = document.createElement("div");
      none.className = "mm-none";
      none.textContent = `没有叫“${search.value.trim()}”的模型`;
      list.replaceChildren(none);

      return;
    }

    list.replaceChildren(...groupModelsByProvider(hits).flatMap((group) => {
      const label = document.createElement("div");
      label.className = "mm-group";
      label.textContent = providerLabel(group.provider);

      return [label, ...group.models.map((m) => { const r = row(m); r.querySelector(".mm-desc")!.remove(); return r; })];
    }));
  };

  const rows = () => [...(view === "main" ? main : list).querySelectorAll<HTMLButtonElement>(".mm-row")];

  const highlight = (index: number | null) => {
    const items = rows();
    const at = index === null || !items.length ? -1 : ((index % items.length) + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("mm-nav", i === at));
    items[at]?.scrollIntoView({ block: "nearest" });
  };

  const highlighted = () => rows().findIndex((el) => el.classList.contains("mm-nav"));

  const fit = () => { menu.style.height = `${(view === "main" ? main : all).offsetHeight}px`; };

  const isOpen = () => menu.classList.contains("open");

  const show = (next: "main" | "all", seed?: string) => {
    view = next;
    menu.classList.toggle("mm-in-all", next === "all");
    main.inert = next !== "main";
    all.inert = next !== "all";

    if (next === "all") {
      if (seed !== undefined) search.value = seed;
      paintAll();
      search.focus({ preventScroll: true });
    } else {
      paintMain();
      menu.focus({ preventScroll: true });
    }

    fit();
    highlight(next === "all" && search.value.trim() ? 0 : null);
  };

  const open = (on: boolean, viaKeyboard = false) => {
    if (on === isOpen()) return;

    const hadFocus = menu.contains(document.activeElement);
    menu.inert = !on;

    if (on) {
      search.value = "";
      paintAll();
      menu.classList.add("mm-instant");
      show("main");
      requestAnimationFrame(() => menu.classList.remove("mm-instant"));
    }

    menu.classList.toggle("open", on);
    chip.setAttribute("aria-expanded", String(on));

    if (on && viaKeyboard) highlight(rows().findIndex((el) => el.getAttribute("aria-checked") === "true"));

    if (!on && hadFocus) chip.focus({ preventScroll: true });
  };

  const pick = (id: string) => {
    rows().forEach((el) => el.setAttribute("aria-checked", String(el.dataset.model === id)));
    open(false);

    if (id === current) return;
    // 刚换掉的那个也算最近用过：换过去试一下，第一层就能换回来。
    recent = [id, current, ...recent].filter((other, i, all): other is string => Boolean(other) && all.indexOf(other) === i).slice(0, FIRST_LEVEL_MAX - 1);

    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* 记不住最近用过的，只影响第一层排序 */ }
    options.setModel(id);
  };

  const setDeep = (next: boolean) => {
    if (next === deep() && chosen !== undefined) return;
    chosen = next;

    try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* 存不下也照样生效到关闭侧栏 */ }
    options.sendThinking(next);
    const seg = main.querySelector(".mm-seg");
    seg?.classList.toggle("deep", next);
    seg?.querySelectorAll<HTMLButtonElement>("[data-deep]").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.deep === "1") === next)));
    const thinking = currentOption()?.thinking;
    const note = main.querySelector(".mm-effort small");

    if (thinking && note) note.textContent = effortNote(thinking);
    paintChip("level");
  };

  chip.onclick = (event) => { open(!isOpen(), event.detail === 0); };

  menu.addEventListener("click", (event) => {
    const target = event.target as Element;
    const seg = target.closest<HTMLElement>("[data-deep]");

    if (seg) return setDeep(seg.dataset.deep === "1");

    if (target.closest(".mm-back")) return show("main");
    const hit = target.closest<HTMLButtonElement>(".mm-row");

    if (!hit) return;

    if (hit.classList.contains("mm-more")) return show("all");

    if (hit.dataset.model && models.length) pick(hit.dataset.model);
  });

  menu.addEventListener("pointermove", (event) => {
    const hit = (event.target as Element).closest(".mm-row");

    if (hit) highlight(rows().indexOf(hit as HTMLButtonElement));
  });
  menu.addEventListener("pointerleave", () => highlight(null));

  search.addEventListener("input", () => { paintAll(); fit(); highlight(search.value.trim() ? 0 : null); });

  menu.addEventListener("keydown", (event) => {
    const key = event.key;

    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      if (view === "all") show("main");
      else open(false);

      return;
    }

    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const at = highlighted();
      highlight(at < 0 ? (key === "ArrowDown" ? 0 : -1) : at + (key === "ArrowDown" ? 1 : -1));

      return;
    }

    // 焦点在“深入”、返回这些按钮上时，回车按它们自己的；输入法确认候选词的回车也不算选模型。
    if (key === "Enter" && !event.isComposing && (document.activeElement === menu || document.activeElement === search) && highlighted() >= 0) {
      event.preventDefault();
      rows()[highlighted()]!.click();

      return;
    }

    if (key === "ArrowRight" && view === "main" && rows()[highlighted()]?.classList.contains("mm-more")) return show("all");

    if (key === "ArrowLeft" && view === "all" && !search.value) return show("main");

    // 第一层直接打字就进「更多模型」搜索，和 Claude 的模型菜单一样不用先点搜索框。
    if (view === "main" && key.length === 1 && key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey && models.length > firstLevel().length) {
      event.preventDefault();
      show("all", key);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node;

    if (isOpen() && !menu.contains(target) && !chip.contains(target)) open(false);
  });

  const repaint = () => {
    paintChip();

    if (!current && !models.length) return open(false);

    if (!isOpen()) return;

    if (view === "all") paintAll();
    else paintMain();
    fit();
  };

  return {
    update(model, next) {
      const renamed = model !== undefined && model !== current && current !== undefined;
      current = model ?? current;
      models = next ?? models;
      repaint();

      if (renamed) paintChip("name");
    },
    reset() {
      current = undefined;
      models = [];
      repaint();
    },
    connected() {
      if (chosen !== undefined) options.sendThinking(chosen);
    },
  };
}
