/**
 * A 安静列表。
 * 借：Cherry Studio ProviderList.tsx（搜索同时匹配模型名、「已启用」分区标签、组内行）、
 *     Zed settings_ui/pages/llm_providers_page.rs（已配置的 key 只显示一行状态 + 动作）。
 * 结构：当前模型一行 → 一张列表（搜索 / 已连接 / 其余服务商折起）→ 点一行就地展开详情。
 */
import { h, icon, avatar, statusEl, detailForm, bus, modelCombo, setStatus, notice } from "./common";
import { state, connectedEntries, otherEntries, entryStatus, matchEntry, entryOf, choiceOf, labelOf, credNote, CUSTOM_ID, type Entry } from "./data";

export function variantA(): HTMLElement {
  let open: string | null = null;
  let showAll = false;
  let q = "";

  const current = h("div", { class: "surface a-current" });
  const search = h("input", { class: "search-input", type: "search", placeholder: "搜索服务商或模型，比如 glm、claude", "aria-label": "搜索服务商或模型", spellcheck: "false" }) as HTMLInputElement;
  const list = h("div", { class: "a-list" });
  const box = h("div", { class: "surface a-box" }, h("div", { class: "search" }, icon("Search", 14, "search-ic"), search, h("kbd", { text: "/" })), list);

  const drawCurrent = () => {
    const c = state.config; const e = entryOf(c.provider); const st = credNote(c.provider);
    const msg = h("span", { class: "a-cur-msg", role: "status", text: notice.text }); notice.text = "";
    current.replaceChildren(
      avatar(e.name, 32, true),
      h("div", { class: "a-cur-main" }, h("div", { class: "a-cur-k", text: "正在使用" }), h("div", { class: "a-cur-name" }, h("span", { text: labelOf(c.provider) }), statusEl(st === "已登录" ? "oauth" : "key", st || "未配置凭据"))),
      h("div", { class: "a-cur-model" }, modelCombo(choiceOf(c.provider).models, c.modelId, (m) => { if (!m || m === state.config.modelId) return; state.config = { ...state.config, modelId: m }; bus.dispatchEvent(new Event("change")); setStatus(document.querySelector(".a-cur-msg")!, `已换成 ${m}`, "ok"); })),
      msg,
    );
  };

  const rowEl = (e: Entry, models: string[]) => {
    const st = entryStatus(e); const isOpen = open === e.key;
    const btn = h("button", { type: "button", class: "a-row" + (isOpen ? " is-open" : "") + (st.kind === "use" ? " is-use" : ""), "aria-expanded": String(isOpen), "data-key": e.key, onclick: () => { open = isOpen ? null : e.key; draw(); } },
      avatar(e.name, 20, st.kind === "use"),
      h("span", { class: "a-name" }, h("span", { text: e.name }), e.members.length > 1 ? h("span", { class: "a-meta", text: e.members.map((m) => m.region).join(" / ") }) : null, models.length ? h("span", { class: "a-meta a-hit", text: models.length > 1 ? `${models[0]} 等 ${models.length} 个` : models[0] }) : null),
      statusEl(st.kind, st.text, e.members.length > 1 ? st.region : undefined),
      icon("ChevronRight", 14, "a-chev"));
    const wrap = h("div", { class: "a-item" + (isOpen ? " is-open" : ""), "data-key": e.key }, btn);
    if (isOpen) wrap.append(h("div", { class: "a-detail" }, detailForm(e, { onSaved: () => { open = e.key; } })));
    return wrap;
  };

  const draw = () => {
    list.querySelectorAll<HTMLElement & { destroy?: () => void }>(".combo").forEach((c) => c.destroy?.());
    const conn = connectedEntries().map((e) => [e, matchEntry(e, q)] as const).filter(([, m]) => m.hit);
    const rest = otherEntries().map((e) => [e, matchEntry(e, q)] as const).filter(([, m]) => m.hit);
    const custom = entryOf(CUSTOM_ID);
    const kids: HTMLElement[] = [];
    if (conn.length) {
      kids.push(h("div", { class: "grp", text: `已连接 · ${conn.length}` }));
      for (const [e, m] of conn) kids.push(rowEl(e, m.models));
    }
    const restOpen = showAll || q.trim() || rest.some(([e]) => e.key === open);
    if (rest.length) {
      kids.push(h("div", { class: "grp", text: q.trim() ? `其余服务商 · ${rest.length}` : `其余服务商 · ${rest.length}` }));
      if (restOpen) for (const [e, m] of rest) kids.push(rowEl(e, m.models));
      else kids.push(h("button", { type: "button", class: "a-more", onclick: () => { showAll = true; draw(); } }, h("span", { text: rest.slice(0, 4).map(([e]) => e.name).join("、") + ` 等 ${rest.length} 家` }), h("span", { class: "a-more-btn" }, "展开", icon("ChevronDown", 13))));
    }
    if (!conn.length && !rest.length) kids.push(h("p", { class: "empty", text: `没有找到「${q.trim()}」。OpenAI 兼容的服务可以用下面的「自定义地址」接入。` }));
    if (!q.trim() || matchEntry(custom, q).hit || (!conn.length && !rest.length)) { kids.push(h("div", { class: "grp grp-sep" })); kids.push(rowEl(custom, [])); }
    list.replaceChildren(...kids);
  };

  search.addEventListener("input", () => { q = search.value; draw(); });
  search.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { search.value = ""; q = ""; draw(); } });
  addEventListener("keydown", (ev) => { if (ev.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") { ev.preventDefault(); search.focus(); } });
  bus.addEventListener("change", () => { drawCurrent(); draw(); });
  drawCurrent(); draw();

  (window as any).__a = { open: (key: string) => { open = key; showAll = true; draw(); }, search: (s: string) => { search.value = s; q = s; draw(); } };

  return h("section", { class: "sx", "aria-labelledby": "model-title" },
    h("div", { class: "sx-head" }, h("h2", { id: "model-title", text: "模型" }), h("p", { class: "sx-sub", text: "用你自己的套餐调用模型。密钥只保存在这个浏览器里。" })),
    current, box);
}
