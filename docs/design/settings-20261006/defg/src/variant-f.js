/**
 * F · 只列在用的，其余点「添加」（Chatbox src/renderer/components/settings/provider/ProviderList.tsx + ProviderSpotlight.tsx）。
 * ProviderList：只排「已激活 + 自定义 + 推荐」，不铺全部；行 = 32px 图标 + 名称 + 已激活 8px 绿色 Indicator；
 * 小屏形态（BYS 设置页 560px 正合适）：行间分隔线 + 右侧 chevron；当前打开 = 品牌色文字 + 品牌浅底。
 * ProviderSpotlight：搜索 + 分组「常用 / 更多服务商 / 自定义」，24px 图标 + 名称 + 说明；选中后进入这家的详情。
 */
import { h, lu, pico, state, choices, choiceOf, isConnected, isActive, credNote, bysOrder, swap, popIn, reduced, FEATURED, CUSTOM_ID } from "./common.js";
import { detailView } from "./detail.js";

const POPULAR = ["anthropic", "openai", "deepseek", "openrouter", "google", "github-copilot"];

export function variantF(root) {
  let open = null;
  let spot = null;
  const host = h("div", { class: "cb-host" });
  root.replaceChildren(host);

  const render = (dir = 0) => { const v = open ? detailView(choiceOf(open), { backLabel: "服务商", onBack: () => { open = null; render(-1); }, rerender: () => render() }) : list(); dir ? swap(host, v, dir) : host.replaceChildren(v); };
  const go = (id) => { closeSpot(); open = id; render(1); };

  function list() {
    // ProviderList.sortedProviders：已激活（含自定义）在前，再补推荐（BYS 的置顶 4 家 + 自定义地址）。
    const shown = bysOrder(choices.filter((c) => isConnected(c.id) || FEATURED.includes(c.id)));
    shown.sort((a, b) => isActive(b.id) - isActive(a.id));
    const rest = choices.length - shown.length;
    return h("div", { class: "cb" },
      h("div", { class: "cb-list", role: "list" }, shown.map((c) => {
        const note = credNote(c.id);
        return h("button", { type: "button", role: "listitem", class: "cb-row" + (isActive(c.id) ? " is-active" : ""), onclick: () => go(c.id) },
          h("span", { class: "cb-tile" }, pico(c.id, 18)),
          h("span", { class: "cb-text" }, h("span", { class: "cb-name" }, c.name),
            h("span", { class: "cb-sub" }, isActive(c.id) ? `正在使用 · ${state.config.modelId}` : note || "还没连接")),
          isConnected(c.id) ? h("i", { class: "cb-ind", title: note }) : null,
          lu("chevronRight", 18, "cb-chev"));
      })),
      h("button", { type: "button", class: "cb-add", onclick: openSpot }, lu("plus", 15), "添加服务商", h("span", { class: "cb-add-n" }, `还有 ${rest} 家`)));
  }

  function closeSpot() { spot?.remove(); spot = null; }
  function openSpot() {
    closeSpot();
    const input = h("input", { class: "sp-input", placeholder: "搜索服务商…", "aria-label": "搜索服务商" });
    const listEl = h("div", { class: "sp-list", role: "listbox" });
    let items = []; let idx = 0;
    const desc = (c) => isConnected(c.id) ? `已连接 · ${credNote(c.id)}` : c.oauth ? "账号登录或 API key" : c.id === CUSTOM_ID ? "任何 OpenAI 兼容的服务地址" : "API key";
    const action = (c) => h("button", { type: "button", class: "sp-item", role: "option", onclick: () => go(c.id), onmousemove: () => { idx = items.indexOf(c); mark(); } },
      h("span", { class: "sp-ico" }, pico(c.id, 20)), h("span", { class: "sp-text" }, h("span", { class: "sp-label" }, c.name), h("span", { class: "sp-desc" }, desc(c))),
      isConnected(c.id) ? h("i", { class: "cb-ind" }) : null);
    const mark = () => listEl.querySelectorAll(".sp-item").forEach((el, i) => el.classList.toggle("is-hl", i === idx));
    const fill = () => {
      const q = input.value.trim().toLowerCase();
      const match = (c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q);
      const pop = POPULAR.map(choiceOf).filter(match);
      const more = bysOrder(choices.filter((c) => !POPULAR.includes(c.id) && c.id !== CUSTOM_ID)).filter(match);
      const custom = [choiceOf(CUSTOM_ID)].filter(match);
      const groups = [["常用", pop], ["更多服务商", more], ["自定义", custom]].filter(([, a]) => a.length);
      items = groups.flatMap(([, a]) => a); idx = 0;
      listEl.replaceChildren(...(groups.length ? groups.map(([g, a]) => h("div", { class: "sp-group" }, h("div", { class: "sp-gh" }, g), a.map(action))) : [h("p", { class: "sp-empty" }, "没有找到")]));
      mark();
    };
    input.addEventListener("input", fill);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { idx = Math.min(items.length - 1, idx + 1); mark(); listEl.querySelector(".is-hl")?.scrollIntoView({ block: "nearest" }); e.preventDefault(); }
      if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); mark(); listEl.querySelector(".is-hl")?.scrollIntoView({ block: "nearest" }); e.preventDefault(); }
      if (e.key === "Enter" && items[idx]) go(items[idx].id);
      if (e.key === "Escape") closeSpot();
    });
    const panel = h("div", { class: "sp-panel", role: "dialog", "aria-label": "添加服务商" },
      h("div", { class: "sp-search" }, lu("search", 17), input, h("kbd", { class: "sp-kbd" }, "esc")), listEl);
    spot = h("div", { class: "sp-overlay", onpointerdown: (e) => { if (e.target === spot) closeSpot(); } }, panel);
    document.body.append(spot);
    fill(); input.focus();
    if (!reduced()) { spot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 }); popIn(panel); }
  }

  render();
  return { reset: () => { open = null; closeSpot(); render(); } };
}
