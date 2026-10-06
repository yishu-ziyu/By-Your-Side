/**
 * C 命令面板。
 * 借：Zed agent_ui/src/language_model_selector.rs（只列已连接服务商的模型，按服务商分节，当前模型打勾，键盘上下选）、
 *     Open WebUI chat/ModelSelector/Selector.svelte（一个搜索框同时搜模型和服务商）。
 * 结构：当前模型一张卡 +「换一个」→ ⌘K 浮层；没连接的服务商在浮层底部，选中后在卡片下方展开设置。
 */
import { computePosition, flip, offset, shift, size, autoUpdate } from "@floating-ui/dom";
import { h, icon, avatar, statusEl, detailForm, bus, reduced, Z } from "./common";
import { state, connectedEntries, otherEntries, entryStatus, matchEntry, entryOf, choiceOf, labelOf, credNote, CUSTOM_ID, type Entry } from "./data";

export function variantC(): HTMLElement {
  let setup: string | null = null; // 展开设置的服务商 key
  const card = h("div", { class: "surface c-card" });
  const setupBox = h("div", { class: "c-setup", hidden: true });
  const pal = h("div", { class: "c-pal", role: "dialog", "aria-label": "换模型", hidden: true });
  const q = h("input", { class: "c-q", type: "text", placeholder: "搜索模型或服务商…", "aria-label": "搜索模型或服务商", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
  const body = h("div", { class: "c-body", role: "listbox" });
  pal.append(h("div", { class: "c-qrow" }, icon("Search", 15, "search-ic"), q, h("kbd", { text: "esc" })), body,
    h("div", { class: "c-foot" }, h("span", {}, h("kbd", { text: "↑" }), h("kbd", { text: "↓" }), " 选择"), h("span", {}, h("kbd", {}, icon("CornerDownLeft", 11)), " 使用"), h("span", { class: "grow" }), h("button", { type: "button", class: "c-foot-link", text: "自定义地址", onclick: () => openSetup(CUSTOM_ID) })));
  document.body.append(pal);
  let hi = 0; let cleanup: (() => void) | null = null; let changeBtn: HTMLElement;
  const expanded = new Set<string>();

  const drawCard = () => {
    const c = state.config; const e = entryOf(c.provider); const cn = credNote(c.provider);
    changeBtn = h("button", { type: "button", class: "btn c-change", "aria-haspopup": "dialog", onclick: () => toggle() }, h("span", { text: "换一个" }), h("kbd", { text: "⌘K" }));
    card.replaceChildren(
      avatar(e.name, 36, true),
      h("div", { class: "c-main" }, h("div", { class: "c-name", text: c.modelId }), h("div", { class: "c-meta" }, h("span", { text: labelOf(c.provider) }), statusEl(cn === "已登录" ? "oauth" : cn ? "key" : "", cn))),
      h("button", { type: "button", class: "btn btn-quiet", text: "凭据", onclick: () => openSetup(e.key) }),
      changeBtn);
  };

  const connLine = h("p", { class: "c-conn" });
  const drawConn = () => {
    const conn = connectedEntries();
    connLine.replaceChildren(h("span", { class: "c-conn-k", text: `已连接 ${conn.length} 家：` }), ...conn.flatMap((e, i) => [i ? "、" : "", h("button", { type: "button", class: "c-conn-a", text: e.name, onclick: () => openSetup(e.key) })]));
  };

  const optRow = (attrs: Record<string, unknown>, ...kids: (Node | string | null)[]) => h("div", { class: "c-opt", role: "option", ...attrs }, ...kids);

  const drawBody = () => {
    const s = q.value.trim(); const kids: HTMLElement[] = [];
    for (const e of connectedEntries()) {
      const m = matchEntry(e, s); if (!m.hit) continue;
      const memberIds = e.members.filter((x) => credNote(x.id) || x.id === state.config.provider).map((x) => x.id);
      const st = entryStatus(e);
      kids.push(h("div", { class: "c-sec" }, avatar(e.name, 16, st.kind === "use"), h("span", { class: "c-sec-name", text: e.name }), statusEl(st.kind === "use" ? (credNote(state.config.provider) === "已登录" ? "oauth" : "key") : st.kind, st.kind === "use" ? credNote(state.config.provider) : st.text, e.members.length > 1 ? st.region : undefined), h("span", { class: "grow" }), h("button", { type: "button", class: "c-sec-a", text: "设置", onmousedown: (ev: Event) => { ev.preventDefault(); openSetup(e.key); } })));
      for (const pid of memberIds) {
        const all = choiceOf(pid).models;
        const nameHit = !s || (e.name + " " + pid).toLowerCase().includes(s.toLowerCase());
        let models = s && !nameHit ? m.models.filter((x) => all.includes(x)) : all;
        const cur = state.config.provider === pid ? state.config.modelId : "";
        if (cur && !models.includes(cur) && (!s || nameHit)) models = [cur, ...models];
        const limit = expanded.has(pid) || s ? 50 : 4;
        const shown = models.slice(0, limit);
        if (cur && models.includes(cur) && !shown.includes(cur)) shown.splice(limit - 1, 1, cur);
        for (const id of shown) kids.push(optRow({ "data-act": "model", "data-p": pid, "data-m": id, class: "c-opt" + (pid === state.config.provider && id === state.config.modelId ? " is-cur" : "") }, h("span", { class: "c-opt-name", text: id }), e.members.length > 1 ? h("span", { class: "c-opt-meta", text: e.members.find((x) => x.id === pid)!.region! }) : null, pid === state.config.provider && id === state.config.modelId ? icon("Check", 14, "c-check") : null));
        if (models.length > shown.length) kids.push(optRow({ "data-act": "more", "data-p": pid, class: "c-opt c-opt-more" }, h("span", { text: `另外 ${models.length - shown.length} 个模型` }), icon("ChevronDown", 13)));
      }
    }
    const rest = otherEntries().filter((e) => matchEntry(e, s).hit);
    if (rest.length) {
      kids.push(h("div", { class: "c-sec c-sec-plain" }, h("span", { class: "c-sec-name", text: `添加服务商 · ${rest.length}` })));
      for (const e of rest) {
        const c = choiceOf(e.members[0].id);
        kids.push(optRow({ "data-act": "setup", "data-k": e.key }, avatar(e.name, 18), h("span", { class: "c-opt-name c-opt-prov", text: e.name }), e.members.length > 1 ? h("span", { class: "c-opt-meta", text: e.members.map((x) => x.region).join(" / ") }) : null, h("span", { class: "c-opt-hint", text: c.oauthLabel ? "登录或填 key" : "填 key" })));
      }
    }
    if (!kids.length) kids.push(h("p", { class: "empty", text: `没有「${s}」。OpenAI 兼容的服务可以用「自定义地址」接入。` }));
    body.replaceChildren(...kids);
    hi = Math.max(0, [...body.querySelectorAll(".c-opt")].findIndex((x) => x.classList.contains("is-cur")));
    if (s) hi = 0;
    paintHi();
  };
  const opts = () => [...body.querySelectorAll<HTMLElement>(".c-opt")];
  const paintHi = (scroll = true) => { opts().forEach((o, i) => { o.classList.toggle("is-hi", i === hi); if (i === hi && scroll) o.scrollIntoView({ block: "nearest" }); }); };

  const act = (o: HTMLElement) => {
    const a = o.dataset.act;
    if (a === "model") {
      state.config = { provider: o.dataset.p!, modelId: o.dataset.m! }; close(); bus.dispatchEvent(new Event("change"));
      flash(`已换成 ${labelOf(o.dataset.p!)} · ${o.dataset.m}。侧栏接下来的任务会用它。`);
    } else if (a === "more") { expanded.add(o.dataset.p!); const keep = hi; drawBody(); hi = keep; paintHi(); q.focus(); }
    else if (a === "setup") openSetup(o.dataset.k!);
  };
  body.addEventListener("mousedown", (ev) => { const o = (ev.target as HTMLElement).closest<HTMLElement>(".c-opt"); if (o) { ev.preventDefault(); act(o); } });
  body.addEventListener("mousemove", (ev) => { const o = (ev.target as HTMLElement).closest<HTMLElement>(".c-opt"); if (o) { const i = opts().indexOf(o); if (i !== hi) { hi = i; paintHi(false); } } });
  q.addEventListener("input", drawBody);
  q.addEventListener("keydown", (ev) => {
    const n = opts().length;
    if (ev.key === "ArrowDown") { ev.preventDefault(); hi = (hi + 1) % n; paintHi(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); hi = (hi - 1 + n) % n; paintHi(); }
    else if (ev.key === "Enter") { ev.preventDefault(); const o = opts()[hi]; if (o) act(o); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); }
  });

  const msg = h("p", { class: "c-msg", role: "status", "aria-live": "polite" });
  const flash = (t: string) => { msg.textContent = t; card.classList.remove("is-flash"); void card.offsetWidth; if (!reduced()) card.classList.add("is-flash"); };

  function openPal() {
    pal.hidden = false; q.value = ""; expanded.clear(); drawBody(); q.focus();
    cleanup = autoUpdate(card, pal, () => computePosition(card, pal, { placement: "bottom-end", middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12 }), size({ padding: 12, apply({ availableHeight }) { pal.style.maxHeight = `${Math.min(460, availableHeight / Z())}px`; } })] }).then(({ x, y }) => Object.assign(pal.style, { left: `${x / Z()}px`, top: `${y / Z()}px` })));
    pal.classList.remove("is-in"); void pal.offsetWidth; pal.classList.add("is-in");
  }
  function close() { pal.hidden = true; cleanup?.(); cleanup = null; }
  function toggle() { pal.hidden ? openPal() : close(); }
  function openSetup(key: string) {
    close(); setup = key; setupBox.hidden = false;
    setupBox.querySelectorAll<HTMLElement & { destroy?: () => void }>(".combo").forEach((c) => c.destroy?.());
    const e: Entry = entryOf(key === CUSTOM_ID ? CUSTOM_ID : (connectedEntries().concat(otherEntries()).find((x) => x.key === key)?.members[0].id ?? CUSTOM_ID));
    const st = entryStatus(e);
    setupBox.replaceChildren(
      h("div", { class: "c-setup-head" }, avatar(e.name, 24, st.kind === "use"), h("h3", { text: e.name }), statusEl(st.kind, st.text, e.members.length > 1 ? st.region : undefined), h("span", { class: "grow" }), h("button", { type: "button", class: "icon-btn", "aria-label": "收起", onclick: () => { setup = null; setupBox.hidden = true; } }, icon("X", 14))),
      detailForm(e, { onSaved: () => {} }));
    setupBox.classList.remove("is-in"); void setupBox.offsetWidth; setupBox.classList.add("is-in");
    setupBox.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
  }
  document.addEventListener("mousedown", (ev) => { if (!pal.hidden && !pal.contains(ev.target as Node) && !changeBtn.contains(ev.target as Node)) close(); });
  addEventListener("keydown", (ev) => { if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); toggle(); } });
  bus.addEventListener("change", () => { drawCard(); drawConn(); });
  drawCard(); drawConn();
  (window as any).__c = { open: openPal, type: (s: string) => { q.value = s; drawBody(); }, setup: openSetup };

  return h("section", { class: "sx", "aria-labelledby": "model-title" },
    h("div", { class: "sx-head" }, h("h2", { id: "model-title", text: "模型" }), h("p", { class: "sx-sub", text: "用你自己的套餐调用模型。密钥只保存在这个浏览器里。" })),
    card, msg, setupBox, connLine);
}
