/** 模型以下的几节：三版共用，统一成「一节一块面、行之间细线」，不再卡片套卡片。文案取自现有 settings/main.ts。 */
import { h, icon, bus, setStatus } from "./common";
import { state, CHOICES, CUSTOM_ID, credNote, labelOf, STEP_VOICES, PERSONAS } from "./data";

const section = (id: string, title: string, sub: string | null, ...rows: HTMLElement[]) =>
  h("section", { class: "sx", "aria-labelledby": id }, h("div", { class: "sx-head" }, h("h2", { id, text: title }), sub ? h("p", { class: "sx-sub", text: sub }) : null), h("div", { class: "surface rows" }, ...rows));

const row = (title: string, desc: string | null, control: Node | null, extra = "") =>
  h("div", { class: "row " + extra }, h("div", { class: "row-main" }, h("div", { class: "row-title", text: title }), desc ? h("div", { class: "row-desc", text: desc }) : null), control ? h("div", { class: "row-ctl" }, control) : null);

const toggle = (key: keyof typeof state.toggles, label: string) => {
  const input = h("input", { type: "checkbox", class: "sw", role: "switch", "aria-label": label }) as HTMLInputElement;
  input.checked = state.toggles[key];
  input.addEventListener("change", () => { state.toggles[key] = input.checked; });
  return input;
};

export function lowerSections(): HTMLElement[] {
  // 快速模型
  const fast = h("select", { class: "sel", "aria-label": "即时动作用的模型" }) as HTMLSelectElement;
  const fillFast = () => {
    const opts = [new Option("和主模型相同", "")];
    for (const c of CHOICES) { if (c.id === CUSTOM_ID || !credNote(c.id)) continue; for (const m of c.models) opts.push(new Option(`${labelOf(c.id)} · ${m}`, JSON.stringify({ provider: c.id, modelId: m }))); }
    const cur = state.fast ? JSON.stringify(state.fast) : "";
    if (cur && !opts.some((o) => o.value === cur)) opts.push(new Option(`${labelOf(state.fast!.provider)} · ${state.fast!.modelId}`, cur));
    fast.replaceChildren(...opts); fast.value = cur;
  };
  fillFast(); bus.addEventListener("change", fillFast);
  fast.addEventListener("change", () => { state.fast = fast.value ? JSON.parse(fast.value) : null; });

  // 实时语音
  const voiceStatus = h("span", { class: "row-desc" });
  const voiceCtl = h("div", { class: "row-ctl-inline" });
  const drawVoice = () => {
    const viaStep = !state.voiceOwnKey && credNote("stepfun");
    voiceStatus.replaceChildren(state.voiceOwnKey ? h("span", { class: "st st-key" }, icon("KeyRound", 12), h("span", { text: `已保存 · 末四位 ${state.voiceOwnKey.slice(-4)}` })) : viaStep ? h("span", { class: "st st-oauth" }, h("i", { class: "dot" }), h("span", { text: "正在沿用阶跃星辰模型的 key" })) : h("span", { text: "还没有 key" }));
    voiceCtl.replaceChildren(h("button", { type: "button", class: "btn btn-quiet", text: state.voiceOwnKey ? "清除" : "单独填一个", onclick: () => {
      if (state.voiceOwnKey) { state.voiceOwnKey = ""; drawVoice(); return; }
      const input = h("input", { class: "d-input", type: "password", placeholder: "粘贴 StepFun API key", "aria-label": "StepFun API key" }) as HTMLInputElement;
      voiceCtl.replaceChildren(input, h("button", { type: "button", class: "btn btn-primary", text: "保存", onclick: () => { if (input.value.trim()) { state.voiceOwnKey = input.value.trim(); drawVoice(); } } }));
      input.focus();
    } }));
  };
  drawVoice(); bus.addEventListener("change", drawVoice);
  const keyRow = h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title", text: "StepFun API key" }), voiceStatus), voiceCtl);

  let playing = "";
  const timbreRows = h("div", { class: "radio-rows", role: "radiogroup", "aria-label": "音色" });
  const drawTimbre = () => timbreRows.replaceChildren(...STEP_VOICES.map((v) => h("div", { class: "radio-row" + (state.voice === v.id ? " is-on" : "") },
    h("button", { type: "button", class: "radio-hit", role: "radio", "aria-checked": String(state.voice === v.id), onclick: () => { state.voice = v.id; drawTimbre(); } }, h("i", { class: "radio" }), h("span", { text: v.label })),
    h("button", { type: "button", class: "icon-btn", "aria-label": `试听${v.label}`, onclick: () => { playing = playing === v.id ? "" : v.id; drawTimbre(); } }, icon(playing === v.id ? "Pause" : "Play", 13), h("span", { text: playing === v.id ? "停止" : "试听" })))));
  drawTimbre();

  const personaRows = h("div", { class: "radio-rows", role: "radiogroup", "aria-label": "人设" });
  const drawPersona = () => {
    const rows: HTMLElement[] = PERSONAS.map((p) => h("div", { class: "radio-row" + (state.persona === p.id ? " is-on" : "") },
      h("button", { type: "button", class: "radio-hit", role: "radio", "aria-checked": String(state.persona === p.id), onclick: () => { state.persona = p.id; drawPersona(); } }, h("i", { class: "radio" }), h("span", { text: p.label }), h("span", { class: "radio-meta", text: p.summary }))));
    if (state.persona === "custom") rows.push(h("div", { class: "persona-custom" }, h("textarea", { class: "d-input", rows: "3", maxlength: "300", placeholder: "用几句话描述你想要的性格，比如：说话干脆，带点幽默" })));
    personaRows.replaceChildren(...rows);
  };
  drawPersona();

  const traceStatus = h("span", { class: "row-desc", role: "status" });

  return [
    section("fast-title", "快速模型", null,
      row("即时动作用的模型", "划词解释、网页翻译、找东西这类要当场出结果的动作用它，并且不让它先思考。不选就用主模型。", fast)),
    section("voice-title", "实时语音", "语音对话使用阶跃星辰的实时语音。上面模型选了阶跃星辰并填了 key 的话，这里不用再填。",
      keyRow,
      h("div", { class: "row row-stack" }, h("div", { class: "row-main" }, h("div", { class: "row-title", text: "音色" }), h("div", { class: "row-desc", text: "点一下就换，下次开启语音时生效。" })), timbreRows),
      h("div", { class: "row row-stack" }, h("div", { class: "row-main" }, h("div", { class: "row-title", text: "人设" }), h("div", { class: "row-desc", text: "只改变语音的语气和措辞，如实汇报、不乱问这些规则不变。" })), personaRows)),
    section("selection-title", "划词", null,
      row("选中文字后显示「问 AI / 解释」", "关掉后按 ⌘J 或右键「问 By Your Side」仍然可用。已打开的网页立即生效。", toggle("selection", "选中文字后显示工具条")),
      row("按住 Shift 停在链接上，预览目标页", "卡片写目标页的标题和几行要点，不打开新标签；读页面时不带你的登录状态。", toggle("linkPreview", "链接预览")),
      row("主动建议", "看出能帮上忙时，在页面右下角递一张小卡。每次判断会把这一页和最近几页的摘录发给你选的模型。", toggle("nudge", "主动建议"))),
    section("open-threads-title", "继续上次的事", null,
      row("新对话里显示没做完的事", "最多 3 张，只来自这台电脑上的记录。单张点 × 后 7 天内不再出现。", toggle("openThreads", "继续上次的事"))),
    section("trace-title", "诊断记录", null,
      h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "row-title", text: "任务步骤与语音识别记录" }), h("div", { class: "row-desc", text: "留在这台电脑的浏览器里，密码和密钥已去掉，不会上传。排查问题时导出给开发者。" }), traceStatus),
        h("div", { class: "row-ctl-inline" }, h("button", { type: "button", class: "btn btn-quiet", text: "导出", onclick: () => setStatus(traceStatus, "原型不导出文件。") }), h("button", { type: "button", class: "btn btn-quiet", text: "清空", onclick: () => setStatus(traceStatus, "已清空（原型）。") })))),
  ];
}
