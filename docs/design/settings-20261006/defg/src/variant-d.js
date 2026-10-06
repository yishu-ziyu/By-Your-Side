/**
 * D · 按接入方式分组（Raycast Settings → AI → Models & Providers）。
 * Raycast 闭源，结构照 manual.raycast.com 的设置截图：默认模型 / 本地订阅 / API Keys / Custom Providers，
 * 每段一个圆角分组框、行间细线；账号行第二行「绿点 + 账号」；API Key 行「删除 + ↗ 去控制台」；段标题右侧「+」。
 */
import { h, lu, pico, state, choices, choiceOf, labelOf, isActive, last4, bysOrder, detailForm, fakeBusy, setStatus, popIn, CUSTOM_ID } from "./common.js";

export function variantD(root) {
  let adding = null;       // 正在添加 key 的服务商 id
  let menu = null;         // 打开的浮层
  const render = () => { closeMenu(); root.replaceChildren(view()); };

  function closeMenu() { menu?.remove(); menu = null; document.removeEventListener("pointerdown", outside, true); }
  function outside(e) { if (menu && !menu.contains(e.target) && !e.target.closest("[data-menu-trigger]")) closeMenu(); }
  function openMenu(anchor, body) {
    closeMenu();
    menu = h("div", { class: "rc-menu", role: "menu" }, body);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const w = Math.max(260, r.width);
    menu.style.width = `${w}px`;
    menu.style.left = `${Math.min(window.innerWidth - w - 12, r.right - w) + scrollX}px`;
    menu.style.top = `${r.bottom + 4 + scrollY}px`;
    popIn(menu);
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    menu.querySelector("input")?.focus();
  }

  /** 默认模型的下拉：只列已连接服务商的模型，按服务商分节，当前项打勾（Raycast 的模型下拉）。 */
  function modelMenu(anchor, which) {
    const cur = which === "main" ? state.config : state.fast;
    const groups = bysOrder(choices.filter((c) => c.id !== CUSTOM_ID && state.creds[c.id]));
    const body = h("div", { class: "rc-menu-scroll" },
      which === "fast" ? h("button", { class: "rc-mi" + (!cur ? " is-on" : ""), onclick: () => { state.fast = null; render(); } },
        h("span", { class: "rc-mi-ico" }, lu("sparkle", 14)), h("span", { class: "rc-mi-label" }, "和主模型相同"), !cur ? lu("check", 14, "rc-mi-check") : null) : null,
      groups.map((c) => [
        h("div", { class: "rc-mh" }, c.name),
        c.models.slice(0, 6).map((m) => {
          const on = cur?.provider === c.id && cur?.modelId === m;
          return h("button", { class: "rc-mi" + (on ? " is-on" : ""), onclick: () => {
            if (which === "main") state.config = { provider: c.id, modelId: m }; else state.fast = { provider: c.id, modelId: m };
            render();
          } }, h("span", { class: "rc-mi-ico" }, pico(c.id, 14)), h("span", { class: "rc-mi-label" }, m), on ? lu("check", 14, "rc-mi-check") : null);
        }),
      ]));
    openMenu(anchor, body);
  }

  /** 段标题右侧「+」：搜索 + 还没填 key 的服务商（Raycast 的 Add Key → 选服务商）。 */
  function addMenu(anchor) {
    const list = h("div", { class: "rc-menu-scroll" });
    const fill = (q = "") => {
      const items = bysOrder(choices.filter((c) => c.apiKey && c.id !== CUSTOM_ID && state.creds[c.id]?.type !== "api_key" && c.name.toLowerCase().includes(q.toLowerCase())));
      list.replaceChildren(...(items.length ? items.map((c) => h("button", { class: "rc-mi", onclick: () => { adding = c.id; render(); root.querySelector(".rc-add-row input")?.focus(); } },
        h("span", { class: "rc-mi-ico" }, pico(c.id, 14)), h("span", { class: "rc-mi-label" }, c.name), h("span", { class: "rc-mi-note" }, `${c.modelCount} 个模型`))) : [h("p", { class: "rc-empty" }, `没有「${q}」`)]));
    };
    fill();
    openMenu(anchor, [h("div", { class: "rc-menu-search" }, lu("search", 14), h("input", { placeholder: "找服务商", oninput: (e) => fill(e.target.value) })), list]);
  }

  const section = (title, sub, action, ...rows) => h("section", { class: "rc-sec" },
    h("div", { class: "rc-head" }, h("div", {}, h("h2", { class: "rc-title" }, title), sub ? h("p", { class: "rc-sub" }, sub) : null), action),
    h("div", { class: "rc-group" }, rows));

  const pop = (label, ico, onclick) => h("button", { type: "button", class: "rc-pop", "data-menu-trigger": "", onclick },
    ico, h("span", { class: "rc-pop-label" }, label), lu("chevronsUpDown", 13, "rc-pop-chev"));

  const activeTag = (id) => isActive(id) ? h("span", { class: "rc-using" }, "正在使用") : null;

  function view() {
    const main = state.config;
    const oauthRows = bysOrder(choices.filter((c) => c.oauth)).map((c) => {
      const on = state.creds[c.id]?.type === "oauth";
      return h("div", { class: "rc-row rc-row-2" },
        h("div", { class: "rc-id" }, pico(c.id, 16, "rc-ico"),
          h("div", {}, h("div", { class: "rc-name" }, c.name, activeTag(c.id)),
            h("div", { class: "rc-acct" + (on ? " is-on" : "") }, on ? [h("i", { class: "rc-dot" }), "已登录，令牌会自动续期"] : "没有登录"))),
        on ? h("button", { type: "button", class: "rc-ghost", onclick: () => { delete state.creds[c.id]; render(); } }, lu("logOut", 13), "退出")
          : h("button", { type: "button", class: "rc-btn", onclick: async (e) => { await fakeBusy(e.currentTarget, "等待确认…", "登录", 1000); state.creds[c.id] = { type: "oauth" }; render(); } }, "登录"));
    });
    const keyRows = bysOrder(choices.filter((c) => state.creds[c.id]?.type === "api_key")).map((c) =>
      h("div", { class: "rc-row" },
        h("div", { class: "rc-id" }, pico(c.id, 16, "rc-ico"), h("span", { class: "rc-name" }, c.name, activeTag(c.id))),
        h("div", { class: "rc-acts" },
          h("span", { class: "rc-mask" }, `•••• ${last4(c.id)}`),
          h("button", { type: "button", class: "rc-icon", title: "删除 key", "aria-label": `删除 ${c.name} 的 key`, onclick: () => { delete state.creds[c.id]; render(); } }, lu("trash", 15)),
          h("button", { type: "button", class: "rc-icon", title: "打开控制台", "aria-label": `打开 ${c.name} 控制台` }, lu("arrowUpRight", 15)))));
    if (adding) {
      const c = choiceOf(adding);
      const status = h("p", { class: "settings-status rc-add-status" });
      const input = h("input", { type: "password", placeholder: "粘贴 key", autocomplete: "off", spellcheck: "false" });
      const verify = h("button", { type: "button", class: "rc-btn", onclick: async (e) => {
        if (!input.value.trim()) return setStatus(status, "填写 API key。", "err");
        setStatus(status, "正在验证…", "busy"); await fakeBusy(e.currentTarget, "验证中…", "验证", 1100);
        setStatus(status, `可以用：${c.name} 回复了 OK（原型不发请求）。`, "ok"); save.disabled = false;
      } }, "验证");
      const save = h("button", { type: "button", class: "rc-btn is-primary", disabled: true, onclick: () => { state.creds[c.id] = { type: "api_key", key: input.value.trim() }; adding = null; render(); } }, "保存");
      keyRows.push(h("div", { class: "rc-row rc-add-row" },
        h("div", { class: "rc-id" }, pico(c.id, 16, "rc-ico"), h("span", { class: "rc-name" }, c.name)),
        h("div", { class: "rc-add-form" }, input, verify, save,
          h("button", { type: "button", class: "rc-icon", "aria-label": "取消", onclick: () => { adding = null; render(); } }, lu("x", 15))),
        status));
    }
    if (!keyRows.length) keyRows.push(h("div", { class: "rc-row" }, h("span", { class: "rc-sub" }, "还没有 key。点右上角 + 添加。")));

    return h("div", { class: "rc" },
      section("默认模型", null, null,
        h("div", { class: "rc-row" }, h("span", { class: "rc-label" }, "主模型"),
          pop(main ? `${labelOf(main.provider)} · ${main.modelId}` : "还没选", main ? pico(main.provider, 14) : null, (e) => modelMenu(e.currentTarget, "main"))),
        h("div", { class: "rc-row" }, h("div", {}, h("span", { class: "rc-label" }, "快速模型"), h("p", { class: "rc-sub" }, "划词解释、翻译这类要当场出结果的动作")),
          pop(state.fast ? `${labelOf(state.fast.provider)} · ${state.fast.modelId}` : "和主模型相同", state.fast ? pico(state.fast.provider, 14) : lu("sparkle", 14), (e) => modelMenu(e.currentTarget, "fast")))),
      section("账号登录", "已经有套餐的，直接登录，不用 key。", null, oauthRows),
      section("API key", "用自己的 key，按服务商的价格付费。密钥只保存在这个浏览器里。",
        h("button", { type: "button", class: "rc-plus", "data-menu-trigger": "", "aria-label": "添加 key", title: "添加 key", onclick: (e) => addMenu(e.currentTarget) }, lu("plus", 16)),
        keyRows),
      section("自定义地址", "任何 OpenAI 兼容的服务，也可以是本机的 Ollama。", null,
        h("div", { class: "rc-row" }, h("div", { class: "rc-id" }, pico(CUSTOM_ID, 16, "rc-ico"), h("span", { class: "rc-name" }, "OpenAI 兼容地址")),
          h("button", { type: "button", class: "rc-btn" }, "添加"))));
  }

  render();
  return { reset: render };
}
