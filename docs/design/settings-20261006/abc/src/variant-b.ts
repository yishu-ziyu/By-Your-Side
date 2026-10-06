/**
 * B 左右两栏。
 * 借：Cherry Studio ProviderSettings（ProviderList/ProviderList.tsx 248px 左栏 + 顶部搜索 + 分区标签；
 *     components/ProviderListItem.tsx 选中行 bg-muted、已启用绿点；ProviderListGroup.tsx 同家多版本合成一行）。
 * 结构：左栏选服务商，右栏只显示这一家的凭据和模型。
 */
import { h, icon, avatar, statusEl, detailForm, bus, reduced } from "./common";
import { state, connectedEntries, otherEntries, entryStatus, matchEntry, entryOf, labelOf, credNote, CUSTOM_ID, type Entry } from "./data";

export function variantB(): HTMLElement {
  let sel = entryOf(state.config.provider).key;
  let q = "";
  const search = h("input", { class: "search-input", type: "search", placeholder: "搜索服务商或模型", "aria-label": "搜索服务商或模型", spellcheck: "false" }) as HTMLInputElement;
  const list = h("div", { class: "b-list", role: "listbox", "aria-label": "服务商" });
  const pane = h("div", { class: "b-pane" });
  const curLine = h("p", { class: "b-cur" });

  const rowEl = (e: Entry, models: string[]) => {
    const st = entryStatus(e);
    const kind = st.kind;
    return h("button", { type: "button", role: "option", class: "b-row" + (sel === e.key ? " is-sel" : ""), "aria-selected": String(sel === e.key), "data-key": e.key, onclick: () => { sel = e.key; draw(); } },
      avatar(e.name, 20, kind === "use"),
      h("span", { class: "b-name" }, h("span", { text: e.name }), models.length && !e.name.toLowerCase().includes(q.trim().toLowerCase()) ? h("span", { class: "b-hit", text: `${models.length} 个模型` }) : null),
      kind === "use" ? h("span", { class: "b-use", text: "使用中" }) : kind === "oauth" ? h("i", { class: "dot dot-ok", title: "已登录" }) : kind === "key" ? icon("KeyRound", 12, "b-key") : null);
  };

  const drawList = () => {
    const conn = connectedEntries().map((e) => [e, matchEntry(e, q)] as const).filter(([, m]) => m.hit);
    const rest = otherEntries().map((e) => [e, matchEntry(e, q)] as const).filter(([, m]) => m.hit);
    const kids: HTMLElement[] = [];
    if (conn.length) { kids.push(h("div", { class: "grp", text: `已连接 · ${conn.length}` })); conn.forEach(([e, m]) => kids.push(rowEl(e, m.models))); }
    if (rest.length) { kids.push(h("div", { class: "grp", text: `全部服务商 · ${rest.length}` })); rest.forEach(([e, m]) => kids.push(rowEl(e, m.models))); }
    if (!conn.length && !rest.length) kids.push(h("p", { class: "empty", text: `没有「${q.trim()}」` }));
    list.replaceChildren(...kids);
  };

  const drawPane = () => {
    pane.querySelectorAll<HTMLElement & { destroy?: () => void }>(".combo").forEach((c) => c.destroy?.());
    const e = ENTRY(sel); const st = entryStatus(e);
    const how = e.members.some((m) => m.id === CUSTOM_ID) ? "接入任何 OpenAI 兼容服务，比如本机的 Ollama。" : "";
    pane.replaceChildren(
      h("div", { class: "b-head" }, avatar(e.name, 32, st.kind === "use"), h("div", { class: "b-head-main" }, h("h3", { text: e.name }), how ? h("p", { class: "b-head-sub", text: how }) : statusEl(st.kind, st.text || "未连接", e.members.length > 1 ? st.region : undefined))),
      detailForm(e, { onSaved: () => {}, modelList: true }),
    );
  };
  const ENTRY = (key: string) => [...connectedEntries(), ...otherEntries(), entryOf(CUSTOM_ID)].find((x) => x.key === key)!;
  const drawCur = () => { curLine.replaceChildren(h("i", { class: "dot dot-use" }), h("span", { class: "b-cur-k", text: "正在使用" }), h("span", { text: `${labelOf(state.config.provider)} · ${state.config.modelId}` })); };
  const draw = () => { drawList(); drawPane(); drawCur(); };

  search.addEventListener("input", () => { q = search.value; drawList(); });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { search.value = ""; q = ""; drawList(); }
    if (ev.key === "Enter") { const first = list.querySelector<HTMLElement>(".b-row"); if (first) { sel = first.dataset.key!; draw(); } }
  });
  bus.addEventListener("change", () => { drawList(); drawCur(); });
  draw();
  (window as any).__b = { select: (key: string) => { sel = key; draw(); }, search: (s: string) => { search.value = s; q = s; drawList(); } };

  const custom = h("button", { type: "button", class: "b-add", onclick: () => { sel = CUSTOM_ID; draw(); } }, icon("Plus", 13), h("span", { text: "自定义地址" }));

  return h("section", { class: "sx", "aria-labelledby": "model-title" },
    h("div", { class: "sx-head sx-head-row" }, h("div", {}, h("h2", { id: "model-title", text: "模型" }), h("p", { class: "sx-sub", text: "用你自己的套餐调用模型。密钥只保存在这个浏览器里。" })), curLine),
    h("div", { class: "surface b-box" },
      h("div", { class: "b-side" }, h("div", { class: "search search-sm" }, icon("Search", 13, "search-ic"), search), list, custom),
      pane));
}
