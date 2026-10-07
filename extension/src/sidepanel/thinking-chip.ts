import type { ModelOption } from "../../../shared/protocol.js";

/**
 * 输入框左下角「6 Luna · 快」：写明当前模型和思考强度，点开在「快 / 深入」间切换，每项写明这个模型实际用哪一档。
 * 选择存在本机、对所有会话生效；没选过时不发，按模型登记的起始档。不能调思考的模型不显示。
 * 方向见 docs/previews/thinking-level（用户 10-07 选方向三）。
 */
const LEVEL: Record<string, string> = { off: "关", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };

const KEY = "sideagent.thinkingDeep";

const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

export function mountThinkingChip(options: { composer: HTMLElement; after: HTMLElement; send: (deep: boolean) => void; openModels: () => void }) {
  const chip = document.createElement("button");
  chip.id = "think-chip";
  chip.type = "button";
  chip.hidden = true;
  chip.title = "当前模型与思考强度";
  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");
  options.after.after(chip);

  const menu = document.createElement("div");
  menu.id = "think-menu";
  menu.setAttribute("role", "menu");
  menu.inert = true;
  options.composer.append(menu);

  let chosen: boolean | undefined;

  try {
    const saved = localStorage.getItem(KEY);
    chosen = saved === null ? undefined : saved === "1";
  } catch { /* 读不到就按没选过 */ }

  let model: ModelOption | undefined;

  const open = (on: boolean) => {
    menu.classList.toggle("open", on);
    menu.inert = !on;
    chip.setAttribute("aria-expanded", String(on));
  };

  const item = (deep: boolean, title: string, level: string, use: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String((chosen ?? false) === deep));
    button.innerHTML = `<span></span><small></small><i aria-hidden="true">✓</i>`;
    button.querySelector("span")!.textContent = title;
    button.querySelector("small")!.textContent = `${LEVEL[level] ?? level}档 · ${use}`;
    button.onclick = () => {
      chosen = deep;

      try { localStorage.setItem(KEY, deep ? "1" : "0"); } catch { /* 存不下也照样生效到关闭侧栏 */ }
      options.send(deep);
      open(false);
      draw();
    };

    return button;
  };

  const draw = () => {
    const thinking = model?.thinking;
    chip.hidden = !thinking;

    if (!model || !thinking) return open(false);
    chip.innerHTML = `<span class="think-model"></span><span>· ${chosen ? "深入" : "快"}</span>${CHEVRON}`;
    chip.querySelector(".think-model")!.textContent = model.name;
    chip.classList.toggle("deep", chosen === true);
    const head = document.createElement("div");
    head.className = "think-head";
    head.textContent = model.name;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "think-more";
    more.textContent = "换模型…";
    more.onclick = () => { open(false); options.openModels(); };
    menu.replaceChildren(head, item(false, "快", thinking.fast, "填表、订东西、点按"), item(true, "深入", thinking.deep, "多步骤、要权衡的事"), document.createElement("hr"), more);
  };

  chip.onclick = (event) => { event.stopPropagation(); open(!menu.classList.contains("open")); };
  document.addEventListener("click", (event) => { if (!menu.contains(event.target as Node)) open(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu.classList.contains("open")) { open(false); chip.focus(); } });

  return {
    /** 当前模型或模型列表变了。 */
    update(current: string | undefined, models: readonly ModelOption[]) {
      model = models.find((option) => option.id === current) ?? model;
      draw();
    },
    /** 连上宿主后把选过的强度告诉它（新开的宿主不记得）。 */
    connected() {
      if (chosen !== undefined) options.send(chosen);
    },
  };
}
