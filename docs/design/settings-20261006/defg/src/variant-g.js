/**
 * G · 细线列表 + 计数（cline apps/cline-hub/src/webview/src/components/views/settings/provider-list-view.tsx）。
 * 标题下一行「N 家可用 · M 家已连接」；右上搜索按钮（点开才出现 h-9 搜索框）+ 深色主按钮；
 * 行：不用卡片，border-b 分隔，min-h-11，名称加粗 + 右侧「N 个模型」灰字 + chevron；选中行 bg-accent/45。
 * BYS 的改动：Cline 行尾是启用开关，BYS 没有「启用」概念，换成状态字（已连接 / 正在使用）；已连接的排前面。
 */
import { h, lu, pico, state, choices, choiceOf, isConnected, isActive, credNote, bysOrder, swap, popIn } from "./common.js";
import { detailView } from "./detail.js";

export function variantG(root) {
  let open = null, searching = false, q = "", sel = null;
  const host = h("div", { class: "cl-host" });
  root.replaceChildren(host);
  const render = (dir = 0) => {
    const v = open ? detailView(choiceOf(open), { backLabel: "服务商", onBack: () => { sel = open; open = null; render(-1); }, rerender: () => render() }) : list();
    dir ? swap(host, v, dir) : host.replaceChildren(v);
    if (!open && searching) { const s = host.querySelector(".cl-search input"); s?.focus(); s?.setSelectionRange(q.length, q.length); }
  };

  function list() {
    const connected = choices.filter((c) => isConnected(c.id)).length;
    const all = bysOrder(choices);
    const ordered = [...all.filter((c) => isActive(c.id)), ...all.filter((c) => !isActive(c.id) && isConnected(c.id)), ...all.filter((c) => !isConnected(c.id))];
    const shown = q ? ordered.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.id.includes(q.toLowerCase())) : ordered;
    const searchBox = searching ? h("div", { class: "cl-search" }, lu("search", 15), h("input", { placeholder: "搜索服务商", "aria-label": "搜索服务商", value: q, oninput: (e) => { q = e.target.value; render(); } })) : null;
    if (searchBox) popIn(searchBox);
    return h("div", { class: "cl" },
      h("div", { class: "cl-head" },
        h("div", {}, h("h2", { class: "cl-title" }, "模型"), h("p", { class: "cl-count" }, `${choices.length} 家可用 · ${connected} 家已连接 · 密钥只保存在这个浏览器里`)),
        h("div", { class: "cl-actions" },
          h("button", { type: "button", class: "cl-iconbtn" + (searching ? " is-on" : ""), "aria-label": "搜索服务商", onclick: () => { searching = !searching; if (!searching) q = ""; render(); } }, lu("search", 16)),
          h("button", { type: "button", class: "cl-primary", onclick: () => { open = "custom"; render(1); } }, lu("plus", 15), "添加地址"))),
      searchBox,
      h("div", { class: "cl-list" },
        shown.length ? shown.map((c) => {
          const note = credNote(c.id);
          const status = isActive(c.id) ? h("span", { class: "cl-st is-active" }, "正在使用")
            : note ? h("span", { class: "cl-st is-ok" }, h("i", { class: "cl-dot" }), note) : null;
          return h("div", { class: "cl-row" + (sel === c.id ? " is-sel" : "") },
            h("button", { type: "button", class: "cl-main", onclick: () => { open = c.id; render(1); } },
              pico(c.id, 16, "cl-ico"), h("span", { class: "cl-name" }, c.name), status,
              h("span", { class: "cl-models" }, c.id === "custom" ? "自己填模型" : `${c.modelCount} 个模型`)),
            h("button", { type: "button", class: "cl-chev", "aria-label": `设置 ${c.name}`, onclick: () => { open = c.id; render(1); } }, lu("chevronRight", 16)));
        }) : h("div", { class: "cl-empty" }, `没有和「${q}」匹配的服务商。`)));
  }

  render();
  return { reset: () => { open = null; searching = false; q = ""; sel = null; render(); } };
}
