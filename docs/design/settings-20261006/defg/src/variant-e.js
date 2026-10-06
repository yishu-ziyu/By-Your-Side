/**
 * E · 一页平铺（Zed crates/settings_ui/src/pages/llm_providers_page.rs）。
 * render_provider_section：每家一段，首段 pt-4、其后 pt-8，gap-1.5；
 * render_provider_header：灰色图标 + 等宽小号灰名称 + 淡分隔线；
 * render_api_key_providers_item：左「API key」+ 去控制台说明（最多半宽），右输入框，回车保存；
 * ConfiguredApiCard（crates/ui/src/components/ai/configured_api_card.rs）：✓ 绿勾 + 状态文字 + 右侧「↺ 重置」。
 * BYS 补的一处：Zed 在这页不标当前模型，这里在段头右侧写「正在使用 · 模型」，已配置的段头给「用这家」。
 */
import { h, lu, pico, state, choices, isActive, last4, bysOrder, setStatus, popIn, CUSTOM_ID } from "./common.js";

const CONSOLE = { deepseek: "DeepSeek 控制台", anthropic: "Anthropic 控制台", openai: "OpenAI 控制台", openrouter: "OpenRouter 控制台", google: "Google AI Studio" };

export function variantE(root) {
  let q = "";
  const render = (focusId) => {
    root.replaceChildren(view());
    if (focusId) root.querySelector(`[data-sec="${focusId}"] .zd-card`)?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  };

  function header(c) {
    const right = isActive(c.id) ? h("span", { class: "zd-using" }, `正在使用 · ${state.config.modelId}`)
      : state.creds[c.id] ? h("button", { type: "button", class: "zd-use", onclick: () => { state.config = { provider: c.id, modelId: c.defaultModel ?? c.models[0] }; render(); } }, "用这家") : null;
    return h("div", { class: "zd-head" },
      h("div", { class: "zd-head-row" }, pico(c.id, 14, "zd-ico"), h("span", { class: "zd-name" }, c.name), h("span", { class: "zd-spacer" }), right),
      h("div", { class: "zd-div" }));
  }

  const card = (label, button, onclick) => h("div", { class: "zd-card" },
    h("div", { class: "zd-card-l" }, lu("check", 15, "zd-ok"), h("span", {}, label)),
    h("button", { type: "button", class: "zd-card-btn", onclick }, lu(button === "退出登录" ? "logOut" : "undo", 13), button));

  function keyRow(c) {
    const input = h("input", { class: "zd-input", type: "password", placeholder: "xxxxxxxxxxxxxxxxxxxx", "aria-label": `${c.name} API key`, autocomplete: "off", spellcheck: "false",
      onkeydown: (e) => { if (e.key === "Enter" && input.value.trim()) { state.creds[c.id] = { type: "api_key", key: input.value.trim() }; render(c.id); } } });
    return h("div", { class: "zd-item" },
      h("div", { class: "zd-desc" },
        h("div", { class: "zd-label" }, c.oauth ? "或者填写 API key" : "API key"),
        h("div", { class: "zd-help" }, "去 ", h("a", { class: "zd-link", href: "#", onclick: (e) => e.preventDefault() }, CONSOLE[c.id] ?? `${c.name} 控制台`), " 生成 key。"),
        h("div", { class: "zd-help-xs" }, "填好按回车保存，只存在这个浏览器里。")),
      input);
  }

  function oauthRow(c) {
    return h("div", { class: "zd-item" },
      h("div", { class: "zd-desc" }, h("div", { class: "zd-label" }, "账号登录"),
        h("div", { class: "zd-help" }, "用设备码登录：会打开服务商的网页，在那里确认即可。")),
      h("button", { type: "button", class: "zd-outline", onclick: (e) => {
        e.currentTarget.textContent = "等待你在网页上确认…"; e.currentTarget.disabled = true;
        setTimeout(() => { state.creds[c.id] = { type: "oauth" }; render(c.id); }, 1000);
      } }, c.oauth));
  }

  function body(c) {
    const cred = state.creds[c.id];
    if (c.id === CUSTOM_ID) return h("div", { class: "zd-item" },
      h("div", { class: "zd-desc" }, h("div", { class: "zd-label" }, "配置服务商"), h("div", { class: "zd-help" }, "任何 OpenAI 兼容的服务地址，也可以是本机服务。")),
      h("button", { type: "button", class: "zd-outline" }, "配置", lu("chevronRight", 13)));
    if (cred?.type === "oauth") return card("已登录，令牌会自动续期", "退出登录", () => { delete state.creds[c.id]; render(); });
    if (cred?.type === "api_key") return card(`已填 key（末四位 ${last4(c.id)}）`, "重置 key", () => { delete state.creds[c.id]; render(); });
    return [c.oauth ? oauthRow(c) : null, c.apiKey ? keyRow(c) : null];
  }

  function view() {
    const list = bysOrder(choices).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.id.includes(q.toLowerCase()));
    const search = h("input", { class: "zd-search", placeholder: "搜索设置…", value: q, oninput: (e) => { q = e.target.value; const pos = e.target.selectionStart; render(); const s = root.querySelector(".zd-search"); s.focus(); s.setSelectionRange(pos, pos); } });
    const addBtn = h("button", { type: "button", class: "zd-add", onclick: (e) => {
      const m = h("div", { class: "zd-menu" }, h("div", { class: "zd-menu-h" }, "兼容接口"), h("button", { class: "zd-menu-i" }, "OpenAI 兼容地址"));
      e.currentTarget.parentElement.append(m); popIn(m);
      setTimeout(() => document.addEventListener("pointerdown", function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("pointerdown", off); } }));
    } }, lu("plus", 13), "添加地址");
    return h("div", { class: "zd" },
      h("div", { class: "zd-bar" }, h("div", { class: "zd-searchwrap" }, lu("search", 14), search), h("div", { class: "zd-bar-r" }, addBtn)),
      list.length ? list.map((c, i) => h("section", { class: "zd-sec" + (i === 0 ? " is-first" : ""), "data-sec": c.id }, header(c), body(c)))
        : h("p", { class: "zd-help" }, `没有和「${q}」匹配的服务商。`));
  }

  render();
  return { reset: () => { q = ""; render(); } };
}
