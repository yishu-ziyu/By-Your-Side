// F / G 共用的详情页：返回 + 标题 + 状态一行 + BYS 原有表单。
import { h, lu, pico, state, isActive, credNote, detailForm } from "./common.js";

export function detailView(c, { onBack, backLabel, rerender }) {
  const note = credNote(c.id);
  const st = isActive(c.id) ? h("span", { class: "dt-st is-active" }, h("i", { class: "dt-dot" }), `正在使用 · ${state.config.modelId}`)
    : note ? h("span", { class: "dt-st is-ok" }, h("i", { class: "dt-dot" }), note)
    : h("span", { class: "dt-st" }, c.oauth ? "可以账号登录，也可以填 key" : "还没填 key");
  return h("div", { class: "dt" },
    h("button", { type: "button", class: "dt-back", onclick: onBack }, lu("chevronLeft", 15), backLabel),
    h("div", { class: "dt-head" }, h("span", { class: "dt-tile" }, pico(c.id, 22)), h("div", {}, h("h2", { class: "dt-title" }, c.name), st)),
    h("div", { class: "dt-body" }, detailForm(c, { onSaved: rerender })));
}
