/**
 * 模型选择器：输入区左下角的芯片，以及从芯片长出的搜索面板。
 * 数据源是 agent 下发的 hello_ok.models / model_info；选择后发 set_model，
 * 等 agent 回 model_info 再更新显示（收到回执才改变状态）。
 *
 * DOM 宿主与 send(set_model) 回调由调用方显式注入：模块不查询全局 DOM 宿主，入口不再保留状态镜像。
 */
import { createElement as icon, Check, ChevronDown, Search } from "lucide";
import type { ModelOption } from "../../../shared/protocol.js";
import {
  chipLabel,
  displayName,
  filterModels,
  groupModelsByProvider,
  modelReasoningMeta,
  providerLabel,
  providerMark,
} from "./models.js";

/** 选择器占用的 DOM 宿主（由 sidepanel 入口显式提供）。 */
export interface ModelPickerHost {
  /** 输入区左下的芯片按钮。 */
  button: HTMLButtonElement;
  /** 芯片上的 provider 字母标。 */
  mark: HTMLElement;
  /** 芯片文案。 */
  name: HTMLElement;
  /** 芯片上的能力标签；无可信能力证据时保持隐藏。 */
  reasoningTag: HTMLElement | null;
  /** 搜索面板容器。 */
  popover: HTMLElement;
  /** 输入区，用作面板基线定位参照。 */
  composer: HTMLElement;
  /** 应用容器，用作面板底部定位参照。 */
  app: HTMLElement;
}

export interface ModelPickerOptions {
  host: ModelPickerHost;
  /** 用户选定模型后调用：向外发送 set_model。 */
  sendSetModel: (model: string) => void;
}

export interface ModelPicker {
  /** hello_ok：应用初始模型信息；models 缺省（未下发）时视为空目录。 */
  apply(model: string | undefined, models: ModelOption[] | undefined): void;
  /** model_info：收到 set_model 回执后更新；缺省字段保留现值。 */
  update(model: string | undefined, models: ModelOption[] | undefined): void;
  /** 清空模型状态：会话切换 / 断线重连后回到未选择态。 */
  reset(): void;
  /** 布局变化后重算面板位置；面板未展开时不动作。 */
  reposition(): void;
}

export function mountModelPicker(options: ModelPickerOptions): ModelPicker {
  const {
    button: modelBtn,
    mark: modelMark,
    name: modelName,
    reasoningTag: modelReasoningTag,
    popover: modelPopover,
    composer,
    app,
  } = options.host;

  const sendSetModel = options.sendSetModel;

  /** 当前模型信息：model = "provider/id"，models = 可选列表（已配置凭据的 provider）。 */
  let modelState: { model?: string; models: ModelOption[] } | null = null;
  let modelQuery = "";
  /** false = 只看常用（默认精选集）；true = 列出全部已配置凭据的模型。 */
  let showAllModels = false;

  function closeModelPopover(): void {
    modelPopover.hidden = true;
    modelBtn.setAttribute("aria-expanded", "false");
  }

  function paintMark(el: HTMLElement, provider: string | undefined): void {
    if (!provider) {
      el.hidden = true;

      return;
    }

    const { letter, hue } = providerMark(provider);
    el.hidden = false;
    el.textContent = letter;
    el.style.background = `hsl(${hue} 42% 44%)`;
  }

  function currentProvider(): string | undefined {
    const id = modelState?.model;

    if (!id) return undefined;

    return modelState?.models.find((m) => m.id === id)?.provider ?? id.split("/")[0];
  }

  function positionModelPopover(): void {
    const appBox = app.getBoundingClientRect();
    const box = composer.getBoundingClientRect();
    modelPopover.style.bottom = `${appBox.bottom - box.top + 8}px`;
  }

  /**
   * 面板要从触发它的那颗按钮长出来：把缩放原点对齐到按钮中点。
   * 不能读面板自己的 rect —— 展开动画的 transform 会污染测量，所以用 offsetLeft 换算布局位置。
   */
  function alignModelPopoverOrigin(): void {
    const parent = modelPopover.offsetParent as HTMLElement | null;

    if (!parent) return;
    const popLeft = parent.getBoundingClientRect().left + modelPopover.offsetLeft;
    const btn = modelBtn.getBoundingClientRect();
    const x = Math.round(btn.left - popLeft + btn.width / 2);

    if (x > 0 && x < modelPopover.offsetWidth) {
      modelPopover.style.transformOrigin = `${x}px bottom`;
    }
  }

  /** 展开只有这一次：列表项依次落位。搜索会重渲染列表，靠一次性 class 避免每次输入都重播。 */
  function playPopoverOpening(): void {
    modelPopover.classList.remove("opening");
    void modelPopover.offsetWidth;
    modelPopover.classList.add("opening");
    window.setTimeout(() => modelPopover.classList.remove("opening"), 600);
  }

  function modelSearchInput(): HTMLInputElement | null {
    return modelPopover.querySelector(".model-search-input");
  }

  function ensurePopoverChrome(): HTMLElement {
    let list = modelPopover.querySelector(".model-list") as HTMLElement | null;

    if (list) return list;
    const search = document.createElement("div");
    search.className = "model-search";
    const searchIcon = document.createElement("span");
    searchIcon.className = "model-search-icon";
    searchIcon.appendChild(icon(Search));
    const input = document.createElement("input");
    input.type = "search";
    input.className = "model-search-input";
    input.placeholder = "搜索模型…";
    input.setAttribute("aria-label", "搜索模型");
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      modelQuery = input.value;
      renderModelList();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveModelHighlight(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cur = modelPopover.querySelector(".model-item.current-nav") as HTMLButtonElement | null;
        cur?.click();
      }
    });
    search.append(searchIcon, input);
    // 「只看常用 / 显示全部」开关：agent 下发全量并打 featured 标，
    // 默认只显示精选集；关掉开关才列出所有已配置凭据的模型。
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "model-scope-toggle";
    toggle.setAttribute("aria-pressed", String(showAllModels));
    toggle.textContent = showAllModels ? "只看常用" : "显示全部";
    toggle.title = showAllModels
      ? "收起，只显示常用模型"
      : "展开所有已配置凭据的模型（按 provider 分组，可用搜索过滤）";
    toggle.addEventListener("click", () => {
      showAllModels = !showAllModels;
      toggle.setAttribute("aria-pressed", String(showAllModels));
      toggle.textContent = showAllModels ? "只看常用" : "显示全部";
      toggle.title = showAllModels
        ? "收起，只显示常用模型"
        : "展开所有已配置凭据的模型（按 provider 分组，可用搜索过滤）";
      renderModelList();
    });
    search.append(toggle);
    list = document.createElement("div");
    list.className = "model-list";
    list.setAttribute("role", "listbox");
    modelPopover.replaceChildren(search, list);

    return list;
  }

  function visibleModelButtons(): HTMLButtonElement[] {
    return [...modelPopover.querySelectorAll<HTMLButtonElement>(".model-item")];
  }

  function moveModelHighlight(delta: number): void {
    const items = visibleModelButtons();

    if (items.length === 0) return;
    const idx = items.findIndex((el) => el.classList.contains("current-nav"));
    const next = items[(idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta + items.length) % items.length]!;
    items.forEach((el) => el.classList.toggle("current-nav", el === next));
    next.scrollIntoView({ block: "nearest" });
  }

  function renderModelList(): void {
    const list = ensurePopoverChrome();
    const all = modelState?.models ?? [];
    let models = filterModels(all, modelQuery, !showAllModels);

    // 当前会话模型永远出现在默认视图：agent 的 featured 按它自己当时 current 打，
    // 跨会话目录或枚举先后会让本会话的当前模型漏出去——用户必须还能选回当前模型。
    const currentId = modelState?.model;

    if (!showAllModels && !modelQuery.trim() && currentId && all.some((m) => m.id === currentId) && !models.some((m) => m.id === currentId)) {
      models = [...models, ...all.filter((m) => m.id === currentId)];
    }

    // 旧 agent 不下发 featured 标记时，「只看常用」会把这些模型全滤掉、显示成「暂无可用模型」。
    // 那是数据缺失而不是真的没有模型，此时退回全量，绝不把可达模型藏成不可见。
    if (!showAllModels && models.length === 0 && all.length > 0 && !all.some((m) => m.featured === true)) {
      models = filterModels(all, modelQuery, false);
    }

    list.replaceChildren();

    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "model-empty";

      // 目录本身为空（不是搜索滤空）：告诉用户是数据没到，不是没有模型可选。
      if (modelQuery.trim()) empty.textContent = "无匹配模型";
      else if (modelState?.model) empty.textContent = "模型目录还没拿到，暂时没法切换";
      else empty.textContent = "暂无可用模型";
      list.appendChild(empty);

      return;
    }

    for (const group of groupModelsByProvider(models)) {
      const header = document.createElement("div");
      header.className = "model-group";
      header.textContent = providerLabel(group.provider);
      list.appendChild(header);

      for (const m of group.models) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "model-item";
        item.dataset.model = m.id;
        item.title = m.id;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(m.id === modelState?.model));

        if (m.id === modelState?.model) item.classList.add("current");
        const mark = document.createElement("span");
        mark.className = "model-mark";
        paintMark(mark, m.provider);
        const label = document.createElement("span");
        label.className = "model-label";
        label.textContent = displayName(m);
        item.append(mark, label);
        // 无可信能力证据时不渲染能力标签（issue #2 / 验收 B2）
        const meta = modelReasoningMeta(m.provider, m.modelId);

        if (meta.tag) {
          const tag = document.createElement("span");
          tag.className = `reasoning-tag tag-${meta.tier}`;
          tag.textContent = meta.tag;
          item.append(tag);
        }

        const check = document.createElement("span");
        check.className = "model-check";

        if (m.id === modelState?.model) check.appendChild(icon(Check));
        item.append(check);
        item.onclick = () => {
          closeModelPopover();

          if (m.id !== modelState?.model) sendSetModel(m.id);
        };

        list.appendChild(item);
      }
    }

    const current = list.querySelector(".model-item.current") ?? list.querySelector(".model-item");
    current?.classList.add("current-nav");
  }

  function renderModelPicker(): void {
    const models = modelState?.models ?? [];
    const model = modelState?.model;
    modelBtn.hidden = !model && models.length === 0;
    // 目录还没拿到时，芯片仍显示当前模型：保持可点，让菜单解释原因。
    // 只有连当前模型都不知道时才真禁用（那种状态芯片本来就是隐藏的）。
    modelBtn.disabled = !model && models.length === 0;
    modelName.textContent = chipLabel(model, models);
    modelBtn.title = model ? `切换模型（${model}）` : "切换模型";
    const provider = currentProvider();
    paintMark(modelMark, provider);

    if (modelReasoningTag) {
      if (model) {
        const found = models.find((m) => m.id === model);
        const prov = found?.provider ?? provider ?? "";
        const modelId = found?.modelId ?? (model.includes("/") ? model.split("/")[1]! : model);
        const meta = modelReasoningMeta(prov, modelId);
        // 无可信能力证据时芯片同样不显示能力标签（issue #2 / 验收 B2）
        modelReasoningTag.hidden = !meta.tag;

        if (meta.tag) {
          modelReasoningTag.textContent = meta.tag;
          modelReasoningTag.className = `reasoning-tag tag-${meta.tier}`;
        }
      } else {
        modelReasoningTag.hidden = true;
      }
    }

    // 目录为空但知道当前模型：不强制收起——菜单要能打开并说明「为什么没得选」。
    // 只有完全无信息（无模型也无目录）才没有可展示内容。
    if (!model && models.length === 0) {
      closeModelPopover();

      return;
    }

    if (!modelPopover.hidden) renderModelList();
  }

  /** 合并式更新：model/models 缺省时保留现值，与旧 applyModelInfo 完全一致。 */
  function setModelInfo(model: string | undefined, models: ModelOption[] | undefined): void {
    modelState = { model: model ?? modelState?.model, models: models ?? modelState?.models ?? [] };
    renderModelPicker();
  }

  modelBtn.appendChild(icon(ChevronDown));
  modelBtn.onclick = () => {
    const opening = modelPopover.hidden;

    if (opening) {
      modelQuery = "";
      const input = modelSearchInput();

      if (input) input.value = "";
      renderModelList();
      positionModelPopover();
      modelPopover.hidden = false;
      alignModelPopoverOrigin();
      playPopoverOpening();
      modelBtn.setAttribute("aria-expanded", "true");
      queueMicrotask(() => modelSearchInput()?.focus());
    } else {
      closeModelPopover();
    }
  };

  document.addEventListener("click", (e) => {
    if (!modelPopover.hidden && !modelPopover.contains(e.target as Node) && !modelBtn.contains(e.target as Node)) {
      closeModelPopover();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || modelPopover.hidden) return;
    const input = modelSearchInput();

    if (input && input.value) {
      input.value = "";
      modelQuery = "";
      renderModelList();
      input.focus();

      return;
    }

    closeModelPopover();
  });

  return {
    apply: (model, models) => setModelInfo(model, models ?? []),
    update: (model, models) => setModelInfo(model, models),
    reset: () => {
      modelState = null;
      renderModelPicker();
    },
    reposition: () => {
      if (!modelPopover.hidden) positionModelPopover();
    },
  };
}
