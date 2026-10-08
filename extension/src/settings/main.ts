/**
 * 模型与语音设置页：扩展的独立页面，侧栏「更多 → 模型与语音」打开。
 *
 * 只写 chrome.storage：模型选择（INPROC_CONFIG_KEY）、各家凭据（INPROC_CREDENTIAL_PREFIX）、语音密钥（INPROC_VOICE_KEY）、音色（STEP_VOICE_STORAGE_KEY）。
 * background 监听存储变化，推给扩展内 agent；这里不直接和 agent 通信。
 * 订阅登录用 pi-ai 的设备码流程，登录结果经凭据库直接落盘。
 */
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { Check, ChevronDown, ChevronRight, CircleCheck, createElement as icon, KeyRound, Link, Play, Search } from "lucide";
import { createModelRuntime, DEFAULT_MODELS, FEATURED_PROVIDERS, PROBE_TIMEOUT_MS, probeModel, type ProviderChoice } from "../inproc/model-runtime.js";
import {
  CUSTOM_PROVIDER_ID, INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_FAST_CONFIG_KEY, INPROC_VOICE_KEY, INPROC_VOICE_MODEL_KEY, pickCredentials, resolveVoiceKey, resolveVoiceModel,
  STEPFUN_PROVIDER_ID,
  type InprocModelConfig, type StoredCredential, type StoredCredentials,
} from "../inproc/shared.js";
import { TRACE_SESSIONS_KEPT } from "../../../shared/run-trace-core.js";
import { VOICE_CAPTURE_MAX_AGE_DAYS } from "../../../shared/voice-capture-core.js";
import { clearDiagnostics, exportDiagnostics } from "../shared/trace-store.js";
import { SELECTION_BAR_KEY, isSelectionBarOff } from "../shared/ask-selection.js";
import { LINK_PREVIEW_KEY, isLinkPreviewOff } from "../shared/link-preview.js";
import { NUDGE_KEY, isNudgeOn } from "../shared/nudge.js";
import { isSubscriptionKey, PTT_SPEAK_RESULT, PTT_SPEECH_KEY } from "../shared/ptt.js";
import { OPEN_THREADS_KEY } from "../sidepanel/open-threads.js";
import { CUSTOM_PERSONA_MAX_CHARS, DEFAULT_STEP_VOICE, isStepVoice, ORB_STYLE_STORAGE_KEY, ORB_STYLES, parseOrbStyle, parseVoicePersona, STEP_VOICE_STORAGE_KEY, STEP_VOICES, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS, type OrbStyle, type VoicePersona } from "../../../shared/voice.js";
import { groupEntries, matchEntry, providerIcon, type Entry } from "./providers.js";

async function writeCredential(providerId: string, credential: Credential | StoredCredential | undefined): Promise<void> {
  const key = `${INPROC_CREDENTIAL_PREFIX}${providerId}`;

  if (credential) await chrome.storage.local.set({ [key]: credential });
  else await chrome.storage.local.remove(key);
}

/** 登录与保存用它：凭据一改就落盘。 */
const runtime = createModelRuntime(writeCredential);

const CUSTOM_CHOICE: ProviderChoice = { id: CUSTOM_PROVIDER_ID, name: "自定义地址", apiKey: true, models: [] };

const choices = [...runtime.providerChoices(), CUSTOM_CHOICE];

const entries = groupEntries(choices);

const svg = (node: Parameters<typeof icon>[0], size = 14) => icon(node, { width: size, height: size, "stroke-width": 1.75, "aria-hidden": "true" });

const toggleRow = (id: string, title: string, desc: string) => `
  <label class="row">
    <span class="row-main"><span class="row-title">${title}</span><span class="row-desc">${desc}</span></span>
    <input id="${id}" type="checkbox" class="sw" role="switch" />
  </label>`;

document.getElementById("settings")!.innerHTML = `
  <header class="settings-head">
    <img src="icons/brand-mark.svg" alt="" />
    <h1>模型与语音</h1>
  </header>
  <section class="sx" aria-labelledby="model-title">
    <div class="sx-head">
      <h2 id="model-title">模型</h2>
      <p class="sx-sub">用你自己的套餐调用模型。密钥只保存在这个浏览器里。</p>
    </div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">主模型</span><span id="main-desc" class="row-desc"></span></span>
        <span class="row-ctl pick"><span id="main-icon"></span><select id="main-model" class="sel" aria-label="主模型"></select></span>
      </div>
      <div class="row">
        <span class="row-main"><span class="row-title">快速模型</span><span class="row-desc">划词解释、翻译这类要马上出结果的动作用它。</span></span>
        <span class="row-ctl"><select id="fast-model" class="sel" aria-label="快速模型"></select></span>
      </div>
    </div>
    <p id="main-status" class="settings-status" role="status" aria-live="polite"></p>
    <p id="fast-status" class="settings-status" role="status" aria-live="polite"></p>
    <div class="surface plist">
      <div class="search">
        <input id="provider-search" type="search" placeholder="搜索服务商或模型，比如 glm、claude" aria-label="搜索服务商或模型" spellcheck="false" autocomplete="off" />
        <kbd>/</kbd>
      </div>
      <div id="provider-connected"></div>
      <div id="provider-custom"></div>
      <details id="provider-more">
        <summary class="more"><span id="provider-more-names"></span><span class="more-btn"><span class="more-open">展开</span><span class="more-close">收起</span></span></summary>
        <div id="provider-others"></div>
      </details>
      <p id="provider-empty" class="empty" hidden></p>
    </div>
    <div id="provider-form" class="detail" hidden>
      <div id="region-row" class="seg" role="radiogroup" aria-label="地区" hidden></div>
      <label id="base-url-row" class="d-field" hidden>
        <span class="d-label">服务地址（OpenAI 兼容）</span>
        <input id="base-url" class="d-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/v1" />
      </label>
      <div id="oauth-row" class="d-field" hidden>
        <div class="d-cred">
          <span id="oauth-ok" class="ok-ic" hidden></span>
          <span id="oauth-state" class="d-cred-text"></span>
          <span class="d-cred-acts">
            <button id="oauth-login" type="button" class="btn"></button>
            <button id="oauth-cancel" type="button" class="btn btn-quiet" hidden>取消登录</button>
            <button id="oauth-logout" type="button" class="btn btn-quiet" hidden>退出登录</button>
          </span>
        </div>
        <div id="oauth-flow" class="oauth-flow" hidden></div>
      </div>
      <div id="key-saved" class="d-cred" hidden>
        <span class="key-ic"></span>
        <span class="d-cred-text">已填 key<span id="key-tail" class="d-mono"></span></span>
        <span class="d-cred-acts">
          <button id="key-change" type="button" class="btn btn-quiet">更换</button>
          <button id="key-delete" type="button" class="btn btn-quiet">删除</button>
        </span>
      </div>
      <label id="key-row" class="d-field">
        <span id="key-label" class="d-label">API key</span>
        <input id="api-key" class="d-input" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <div class="d-field">
        <span class="d-label"><span>模型</span><span id="model-meta" class="d-label-meta"></span></span>
        <div class="combo">
          <input id="model-id" class="d-input" role="combobox" aria-label="模型" aria-controls="model-options" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="选择或输入模型名称" />
          <button id="model-toggle" type="button" class="combo-btn" tabindex="-1" aria-label="展开模型列表"></button>
        </div>
        <div id="model-options" class="combo-list" role="listbox" popover="manual"></div>
      </div>
      <div class="d-actions">
        <button id="model-test" type="button" class="btn btn-quiet">测试连接</button>
        <button id="model-fast" type="button" class="btn btn-quiet">用作快速模型</button>
        <span class="grow"></span>
        <button id="model-save" type="button" class="btn btn-primary">保存并使用</button>
      </div>
      <p id="model-status" class="settings-status" role="status" aria-live="polite"></p>
    </div>
  </section>
  <section class="sx" aria-labelledby="voice-title">
    <div class="sx-head">
      <h2 id="voice-title">实时语音</h2>
      <p class="sx-sub">语音对话使用阶跃星辰的实时语音。上面已经填了阶跃星辰的 key，这里就不用再填。</p>
    </div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">StepFun API key</span><span id="voice-state" class="row-desc"></span></span>
        <span class="row-ctl inline">
          <input id="voice-key" class="d-input" type="password" autocomplete="off" spellcheck="false" aria-label="StepFun API key" />
          <button id="voice-save" type="button" class="btn">保存</button>
          <button id="voice-clear" type="button" class="btn btn-quiet" hidden>清除</button>
        </span>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="voice-model-title" class="row-title">语音模型</span><span id="voice-model-state" class="row-desc">沿用现有阶跃星辰 key；保存后下次开启语音时生效。</span></span>
        <div id="voice-model-list" class="radio-rows" role="radiogroup" aria-labelledby="voice-model-title"></div>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="timbre-title" class="row-title">音色</span><span class="row-desc">点一下就换，下次开启语音时生效。</span></span>
        <div id="timbre-list" class="radio-rows" role="radiogroup" aria-labelledby="timbre-title"></div>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="orb-title" class="row-title">光球</span><span class="row-desc">欢迎页和语音里的光球，点一下立即换。</span></span>
        <div id="orb-list" class="radio-rows" role="radiogroup" aria-labelledby="orb-title"></div>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="persona-title" class="row-title">人设</span><span class="row-desc">只改变语音的语气和措辞；如实汇报、不乱问这些规则不变。下次开启语音时生效。</span></span>
        <div id="persona-list" class="radio-rows" role="radiogroup" aria-labelledby="persona-title"></div>
        <div id="persona-custom" class="persona-custom" hidden>
          <textarea id="persona-text" class="d-input" rows="3" maxlength="${CUSTOM_PERSONA_MAX_CHARS}" placeholder="用几句话描述你想要的性格，比如：说话干脆，带点幽默"></textarea>
          <div class="d-actions">
            <span id="persona-count" class="d-hint"></span>
            <span class="grow"></span>
            <button id="persona-save" type="button" class="btn btn-primary">保存</button>
          </div>
        </div>
      </div>
      <div class="row">
        <span class="row-main"><span class="row-title">MiniMax 订阅 Key</span><span id="speech-state" class="row-desc"></span></span>
        <span class="row-ctl inline">
          <input id="speech-key" class="d-input" type="password" autocomplete="off" spellcheck="false" aria-label="MiniMax 订阅 Key" />
          <button id="speech-save" type="button" class="btn">保存</button>
          <button id="speech-clear" type="button" class="btn btn-quiet" hidden>清除</button>
        </span>
      </div>
      ${toggleRow("ptt-speak", "按住说话的事做完，念出结果", "念回答的第一句和「留给你的」，用 MiniMax speech-2.8-hd。只接受 Token Plan 订阅 Key（sk-cp- 开头），不走按量计费。")}
    </div>
    <p id="voice-status" class="settings-status" role="status" aria-live="polite"></p>
    <p id="persona-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="selection-title">
    <div class="sx-head"><h2 id="selection-title">划词</h2></div>
    <div class="surface rows">
      ${toggleRow("selection-bar", "选中文字后显示「问 AI / 解释」", "关掉后按 ⌘J 或右键「问 By Your Side」仍然可用。已打开的网页立即生效。")}
      ${toggleRow("link-preview", "按住 Shift 停在链接上，预览目标页", "卡片写目标页的标题和几行要点，不打开新标签；读页面时不带你的登录状态。")}
      ${toggleRow("nudge", "主动建议", "看出能帮上忙时，在页面右下角递一张小卡，点一下交给侧栏去做。每次判断会把这一页和最近几页的摘录发给你选的模型；同一页只看一次。")}
    </div>
    <p id="selection-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="open-threads-title">
    <div class="sx-head"><h2 id="open-threads-title">继续上次的事</h2></div>
    <div class="surface rows">
      ${toggleRow("open-threads", "新对话里显示没做完的事", "最多 3 张，只来自这台电脑上的记录：中断的任务、交给你的页面、没答完的追问。单张点 × 后 7 天内不再出现。")}
    </div>
    <p id="open-threads-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="trace-title">
    <div class="sx-head"><h2 id="trace-title">诊断记录</h2></div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">任务步骤与语音识别记录</span><span class="row-desc">留在这台电脑的浏览器里，密码和密钥已去掉，不存录音，不上传。任务保留最近 ${TRACE_SESSIONS_KEPT} 个会话，语音保留 ${VOICE_CAPTURE_MAX_AGE_DAYS} 天。排查问题时导出给开发者。</span></span>
        <span class="row-ctl inline">
          <button id="trace-export" type="button" class="btn">导出</button>
          <button id="trace-clear" type="button" class="btn btn-quiet">清空</button>
        </span>
      </div>
    </div>
    <p id="trace-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
`;

const isText = (value: unknown): value is string => typeof value === "string";

// SAFETY: 只用于上面模板里写死的 id，调用方给的元素类型与模板标签一致。
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $("provider-form");

const regionRow = $("region-row");

const oauthRow = $("oauth-row");

const oauthOk = $("oauth-ok");

const oauthLogin = $<HTMLButtonElement>("oauth-login");

const oauthCancel = $<HTMLButtonElement>("oauth-cancel");

const oauthLogout = $<HTMLButtonElement>("oauth-logout");

const oauthState = $("oauth-state");

const oauthFlow = $("oauth-flow");

const baseUrlRow = $("base-url-row");

const baseUrlInput = $<HTMLInputElement>("base-url");

const keySaved = $("key-saved");

const keyRow = $("key-row");

const keyLabel = $("key-label");

const keyInput = $<HTMLInputElement>("api-key");

const keyTail = $("key-tail");

const modelMeta = $("model-meta");

const modelInput = $<HTMLInputElement>("model-id");

const modelOptions = $("model-options");

const modelStatus = $("model-status");

const search = $<HTMLInputElement>("provider-search");

const more = $<HTMLDetailsElement>("provider-more");

const mainSelect = $<HTMLSelectElement>("main-model");

const mainStatus = $("main-status");

const voiceInput = $<HTMLInputElement>("voice-key");

const voiceClear = $<HTMLButtonElement>("voice-clear");

const voiceStatus = $("voice-status");

const speechInput = $<HTMLInputElement>("speech-key");

const speechClear = $<HTMLButtonElement>("speech-clear");

const speakToggle = $<HTMLInputElement>("ptt-speak");

let config: InprocModelConfig | null = null;

let fastConfig: InprocModelConfig | null = null;

const fastSelect = $<HTMLSelectElement>("fast-model");

const fastStatus = $("fast-status");

let credentials: StoredCredentials = {};

let selected: ProviderChoice | null = null;

/** 展开详情的那一行（Entry.key）。 */
let openKey: string | null = null;

/** 已存 key 时，点了「更换」才露出输入框。 */
let changingKey = false;

let login: AbortController | null = null;

$("model-toggle").append(svg(ChevronDown));

$("provider-search").before(svg(Search));

oauthOk.append(svg(CircleCheck, 15));

keySaved.querySelector(".key-ic")!.append(svg(KeyRound));

/** detail：服务商原文，收进「技术详情」，不和人话拼在一起。 */
function setStatus(el: HTMLElement, text: string, tone: "ok" | "err" | "busy" | "" = "", detail?: string): void {
  el.textContent = text;
  el.dataset.tone = tone;

  if (!detail) return;
  const details = document.createElement("details");
  details.className = "settings-tech";
  const summary = document.createElement("summary");
  summary.textContent = "技术详情";
  const pre = document.createElement("pre");
  pre.textContent = detail;
  details.append(summary, pre);
  el.append(details);
}

const choiceOf = (providerId: string) => choices.find((c) => c.id === providerId);

const entryOf = (providerId: string) => entries.find((e) => e.members.some((m) => m.id === providerId));

/** 带地区的家族成员写成「MiniMax（中国）」。 */
function labelOf(providerId: string): string {
  const entry = entryOf(providerId);
  const region = entry?.members.find((m) => m.id === providerId)?.region;

  return entry ? region ? `${entry.name}（${region}）` : entry.name : providerId;
}

function credentialNote(providerId: string): "已登录" | "已填 key" | "" {
  const credential = credentials[providerId];

  if (credential?.type === "oauth") return "已登录";

  if (credential?.type === "api_key" && credential.key) return "已填 key";

  return "";
}

const connected = (entry: Entry) => entry.members.some((m) => credentialNote(m.id) || m.id === config?.provider);

/** 一行的状态：使用中 > 已登录 > 已填 key。 */
interface EntryStatus { kind: "use" | "oauth" | "key" | ""; text: string; region?: string }

function entryStatus(entry: Entry): EntryStatus {
  const use = entry.members.find((m) => m.id === config?.provider);

  if (use) return { kind: "use", text: "使用中", region: use.region };

  for (const [kind, text] of [["oauth", "已登录"], ["key", "已填 key"]] as const) {
    const member = entry.members.find((m) => credentialNote(m.id) === text);

    if (member) return { kind, text, region: member.region };
  }

  return { kind: "", text: "" };
}

function statusEl(entry: Entry): HTMLElement {
  const { kind, text, region } = entryStatus(entry);
  const el = document.createElement("span");
  el.className = `st st-${kind || "none"}`;

  if (!kind) return el;
  el.append(kind === "key" ? svg(KeyRound, 12) : Object.assign(document.createElement("i"), { className: "dot" }));
  el.append(entry.members.length > 1 && region ? `${text} · ${region}` : text);

  return el;
}

/** 家族里先打开正在用的、再是已连接的地区。 */
const representative = (entry: Entry) => (entry.members.find((m) => m.id === config?.provider) ?? entry.members.find((m) => credentialNote(m.id)))?.id ?? entry.key;

function providerRow(entry: Entry, hits: string[]): HTMLElement {
  const isOpen = openKey === entry.key;
  const id = representative(entry);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "provider-option prow";
  button.dataset.provider = id;
  button.setAttribute("aria-expanded", String(isOpen));
  const name = document.createElement("span");
  name.className = "p-name";
  name.append(Object.assign(document.createElement("span"), { textContent: entry.name }));

  if (entry.members.length > 1) name.append(Object.assign(document.createElement("span"), { className: "p-meta", textContent: entry.members.map((m) => m.region).join(" / ") }));

  if (hits.length) name.append(Object.assign(document.createElement("span"), { className: "p-meta p-hit", textContent: hits.length > 1 ? `${hits[0]} 等 ${hits.length} 个` : hits[0] }));
  const lead = entry.key === CUSTOM_PROVIDER_ID ? Object.assign(document.createElement("span"), { className: "pv pv-glyph" }) : providerIcon(id, entry.name);

  if (entry.key === CUSTOM_PROVIDER_ID) lead.append(svg(Link, 15));
  const chevron = svg(ChevronRight);
  chevron.classList.add("p-chev");
  button.append(lead, name, statusEl(entry), chevron);
  button.addEventListener("click", () => toggle(entry));
  const item = document.createElement("div");
  item.className = `pitem${isOpen ? " is-open" : ""}${entryStatus(entry).kind === "use" ? " is-use" : ""}`;
  item.append(button);

  if (isOpen) item.append(form);

  return item;
}

function groupLabel(text: string): HTMLElement {
  return Object.assign(document.createElement("div"), { className: "grp", textContent: text });
}

/** 已连接的在上（正在用的第一），自定义地址其次，其余折起；搜索时只留命中的行，并展开其余。 */
function renderProviders(): void {
  const query = search.value.trim();
  const matches = entries.filter((e) => e.key !== CUSTOM_PROVIDER_ID).map((e) => [e, matchEntry(e, choices, query)] as const).filter(([, m]) => m.hit);
  const mine = matches.filter(([e]) => connected(e)).sort(([a], [b]) => Number(entryStatus(b).kind === "use") - Number(entryStatus(a).kind === "use"));
  const rest = matches.filter(([e]) => !connected(e));
  const custom = entries.find((e) => e.key === CUSTOM_PROVIDER_ID)!;
  const customHit = !query || matchEntry(custom, choices, query).hit || !matches.length;

  $("provider-connected").replaceChildren(...mine.length ? [groupLabel(`已连接 · ${mine.length}`), ...mine.map(([e, m]) => providerRow(e, m.models))] : []);
  $("provider-others").replaceChildren(...rest.map(([e, m]) => providerRow(e, m.models)));
  more.hidden = !rest.length;
  $("provider-more-names").replaceChildren(groupLabel(`其余服务商 · ${rest.length}`), Object.assign(document.createElement("span"), {
    className: "more-names", textContent: `${rest.slice(0, 4).map(([e]) => e.name).join("、")}${rest.length > 4 ? ` 等 ${rest.length} 家` : ""}`,
  }));

  if (query || rest.some(([e]) => e.key === openKey)) more.open = true;
  const empty = $("provider-empty");
  empty.hidden = matches.length > 0;
  empty.textContent = `没有找到「${query}」。OpenAI 兼容的服务可以用下面的「自定义地址」接入。`;
  $("provider-custom").replaceChildren(...customHit ? [providerRow(custom, [])] : []);

  if (openKey && !form.isConnected) closeForm();
}

function closeForm(): void {
  openKey = null;
  selected = null;
  form.hidden = true;
  closeModelList();
  form.remove();
}

function toggle(entry: Entry): void {
  if (login) return;

  if (openKey === entry.key) {
    closeForm();
    renderProviders();

    return;
  }

  select(choiceOf(representative(entry))!);
}

function defaultModel(choice: ProviderChoice): string {
  if (config?.provider === choice.id) return config.modelId;

  return FEATURED_PROVIDERS.find((p) => p.id === choice.id)?.defaultModel ?? DEFAULT_MODELS.get(choice.id) ?? choice.models[0] ?? "";
}

function renderRegions(): void {
  const entry = selected && entryOf(selected.id);
  regionRow.hidden = !entry || entry.members.length < 2;

  if (!entry || regionRow.hidden) return;
  regionRow.replaceChildren(...entry.members.map((m) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(m.id === selected!.id));
    button.dataset.region = m.id;
    button.append(m.region ?? m.id);

    if (credentialNote(m.id)) button.append(Object.assign(document.createElement("i"), { className: "seg-dot", title: credentialNote(m.id) }));
    button.addEventListener("click", () => { if (!login && m.id !== selected?.id) select(choiceOf(m.id)!); });

    return button;
  }));
}

function renderCredentialState(): void {
  if (!selected) return;
  const credential = credentials[selected.id];
  const loggedIn = credential?.type === "oauth";
  const saved = credential?.type === "api_key" && credential.key ? credential.key : "";

  oauthRow.hidden = !selected.oauthLabel;
  oauthLogin.textContent = loggedIn ? "重新登录" : selected.oauthLabel ?? "";
  oauthLogin.classList.toggle("btn-primary", !loggedIn);
  oauthLogin.classList.toggle("btn-quiet", loggedIn);
  oauthLogin.hidden = login !== null;
  oauthCancel.hidden = login === null;
  oauthLogout.hidden = !loggedIn || login !== null;
  oauthOk.hidden = !loggedIn || login !== null;

  if (login === null) oauthState.textContent = loggedIn ? "已登录，令牌会自动续期。" : "会打开服务商的网页，在那里确认即可。";

  keySaved.hidden = !selected.apiKey || !saved || changingKey;
  keyTail.textContent = saved ? ` · 末四位 ${saved.slice(-4)}` : "";
  keyRow.hidden = !selected.apiKey || loggedIn || !!saved && !changingKey;
  keyLabel.textContent = selected.id === CUSTOM_PROVIDER_ID ? "API key（本机服务可以不填）" : selected.oauthLabel ? "或者填写 API key" : "API key";
  keyInput.placeholder = saved ? "粘贴新的 key，留空则沿用" : "粘贴 key";
}

function select(choice: ProviderChoice): void {
  if (login) return;
  selected = choice;
  openKey = entryOf(choice.id)?.key ?? null;
  changingKey = false;
  form.hidden = false;
  baseUrlRow.hidden = choice.id !== CUSTOM_PROVIDER_ID;
  baseUrlInput.value = choice.id === CUSTOM_PROVIDER_ID ? config?.baseUrl ?? "" : "";
  keyInput.value = "";
  modelInput.value = defaultModel(choice);
  modelMeta.textContent = choice.models.length ? `目录 ${choice.models.length} 个，也可以直接输入` : "填写模型名称";
  closeModelList();
  oauthFlow.hidden = true;
  oauthFlow.replaceChildren();
  setStatus(modelStatus, "");
  renderRegions();
  renderCredentialState();
  renderProviders();
}

/* 模型下拉：可搜索的列表，也能直接填目录外的名字（自定义地址必须能填）。 */

let modelActive = -1;

/** 打开时列出全部；输入后只留包含所输文字的。 */
let modelFilter = "";

function renderModelList(): void {
  const models = selected?.models ?? [];
  const query = modelFilter.toLowerCase();
  const shown = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;

  const rows = shown.map((m, i) => {
    const option = document.createElement("div");
    option.className = `combo-opt${m === modelInput.value ? " is-cur" : ""}${i === modelActive ? " is-hi" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(m === modelInput.value));
    option.dataset.id = m;
    option.append(Object.assign(document.createElement("span"), { textContent: m }));

    if (m === modelInput.value) option.append(svg(Check, 13));
    option.addEventListener("mousedown", (event) => { event.preventDefault(); pickModel(m); });

    return option;
  });

  const note = Object.assign(document.createElement("div"), { className: "combo-note" });
  note.textContent = !models.length ? "这家没有模型目录，直接填写模型名称。" : !shown.length ? `目录里没有「${modelFilter}」，保存时按你填的名称调用。` : `${shown.length} 个模型`;
  modelOptions.replaceChildren(note, ...rows);
}

function openModelList(): void {
  if (modelOptions.matches(":popover-open") || !selected) return;
  modelFilter = "";
  modelActive = -1;
  renderModelList();
  const box = modelInput.getBoundingClientRect();
  const below = innerHeight - box.bottom - 12;
  Object.assign(modelOptions.style, { left: `${box.left}px`, width: `${box.width}px`, maxHeight: `${Math.min(280, Math.max(below, 160))}px`, top: below >= 160 ? `${box.bottom + 4}px` : "auto", bottom: below >= 160 ? "auto" : `${innerHeight - box.top + 4}px` });
  modelOptions.showPopover();
  modelInput.setAttribute("aria-expanded", "true");
  modelOptions.querySelector(".is-cur")?.scrollIntoView({ block: "nearest" });
}

function closeModelList(): void {
  if (modelOptions.matches(":popover-open")) modelOptions.hidePopover();
  modelInput.setAttribute("aria-expanded", "false");
}

function pickModel(id: string): void {
  modelInput.value = id;
  closeModelList();
}

modelInput.addEventListener("click", openModelList);

modelInput.addEventListener("blur", closeModelList);

modelInput.addEventListener("input", () => {
  openModelList();
  modelFilter = modelInput.value.trim();
  modelActive = -1;
  renderModelList();
});

modelInput.addEventListener("keydown", (event) => {
  const options = [...modelOptions.querySelectorAll<HTMLElement>(".combo-opt")];

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    openModelList();
    modelActive = Math.max(0, Math.min(options.length - 1, modelActive + (event.key === "ArrowDown" ? 1 : -1)));
    options.forEach((o, i) => o.classList.toggle("is-hi", i === modelActive));
    options[modelActive]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && modelOptions.matches(":popover-open")) {
    event.preventDefault();
    pickModel(options[modelActive]?.dataset.id ?? modelInput.value.trim());
  } else if (event.key === "Escape") closeModelList();
});

$("model-toggle").addEventListener("mousedown", (event) => {
  event.preventDefault();

  if (modelOptions.matches(":popover-open")) return closeModelList();
  modelInput.focus();
  openModelList();
});

addEventListener("scroll", closeModelList, { passive: true });

addEventListener("resize", closeModelList);

/** 表单里的草稿：模型选择 + 新填的 key（没填则为空）。 */
function draft(): { ok: true; config: InprocModelConfig; key: string } | { ok: false; error: string } {
  if (!selected) return { ok: false, error: "先选一个服务商。" };
  const modelId = modelInput.value.trim();

  if (!modelId) return { ok: false, error: "填写模型名称。" };
  const next: InprocModelConfig = { provider: selected.id, modelId };

  if (selected.id === CUSTOM_PROVIDER_ID) {
    const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");

    if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) return { ok: false, error: "服务地址要以 http:// 或 https:// 开头。" };
    next.baseUrl = baseUrl;
  }

  const key = keyInput.value.trim();

  if (!key && !credentials[selected.id] && selected.id !== CUSTOM_PROVIDER_ID) {
    return { ok: false, error: selected.oauthLabel ? "先登录，或填写 API key。" : "填写 API key。" };
  }

  return { ok: true, config: next, key };
}

/** 把服务商和网络层的报错翻成用户能处理的话；原文只进「技术详情」。 */
function explainFailure(raw: string): string {
  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api.?key|token)|forbidden/i.test(raw) ? "key 无效，或这个 key 没有该模型的权限"
    : /\b429\b|rate.?limit|quota|insufficient|余额|额度/i.test(raw) ? "额度用完或请求太频繁，可以稍后再试或换个模型"
      : /\b404\b|model.*(not.*found|does not exist)|不存在/i.test(raw) ? "找不到这个模型，检查模型名称"
        : /connection error|failed to fetch|fetch failed|network|ECONN|ENOTFOUND/i.test(raw) ? "连不上服务商（网络中断或对方没有响应），可以再试一次"
          : "服务商返回了错误";
}

async function testConnection(): Promise<void> {
  const value = draft();

  if (!value.ok) return setStatus(modelStatus, value.error, "err");
  const started = performance.now();
  setStatus(modelStatus, "正在测试…", "busy");
  // 慢的服务商要等十几秒：显示已等待时间，让人知道还在进行。
  const ticker = setInterval(() => setStatus(modelStatus, `正在测试…已等 ${Math.round((performance.now() - started) / 1000)} 秒`, "busy"), 1000);
  // 测试不保存新填的 key；但若用的是已保存的订阅令牌，测试中刷新出的新令牌必须落盘，否则旧令牌已被轮换作废。
  const probe = createModelRuntime((id, credential) => (credential?.type === "oauth" ? writeCredential(id, credential) : undefined));
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  try {
    await probe.credentials.load(value.key ? { ...credentials, [value.config.provider]: { type: "api_key", key: value.key } } : credentials);
    await probeModel(probe, value.config, timeout);
    setStatus(modelStatus, `连接正常（${((performance.now() - started) / 1000).toFixed(1)} 秒）。`, "ok");
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const reason = timeout.aborted ? `${PROBE_TIMEOUT_MS / 1000} 秒内没有收到完整回复，服务商可能正忙，可以再试一次或换个模型` : explainFailure(raw);
    setStatus(modelStatus, `连接失败：${reason}`, "err", timeout.aborted ? undefined : raw);
  } finally {
    clearInterval(ticker);
  }
}

async function save(): Promise<void> {
  const value = draft();

  if (!value.ok) return setStatus(modelStatus, value.error, "err");

  if (value.key) await runtime.credentials.modify(value.config.provider, async () => ({ type: "api_key", key: value.key }));
  await chrome.storage.local.set({ [INPROC_CONFIG_KEY]: value.config });
  keyInput.value = "";
  changingKey = false;
  setStatus(mainStatus, "");
  setStatus(modelStatus, `已保存。侧栏接下来的任务会使用 ${labelOf(value.config.provider)} · ${value.config.modelId}。`, "ok");
}

/** 保存这家的凭据并把所填模型设为快速模型；主模型不变。 */
async function saveAsFast(): Promise<void> {
  const value = draft();

  if (!value.ok) return setStatus(modelStatus, value.error, "err");

  if (value.key) await runtime.credentials.modify(value.config.provider, async () => ({ type: "api_key", key: value.key }));
  await chrome.storage.local.set({ [INPROC_FAST_CONFIG_KEY]: value.config });
  keyInput.value = "";
  changingKey = false;
  setStatus(modelStatus, `已设为快速模型：${labelOf(value.config.provider)} · ${value.config.modelId}。主模型不变。`, "ok");
}

async function deleteKey(): Promise<void> {
  if (!selected) return;
  const inUse = config?.provider === selected.id;
  await runtime.credentials.delete(selected.id);
  await reload();
  setStatus(modelStatus, inUse ? "已删除 key。主模型还是这家，填新 key 或换个模型后才能用。" : "已删除 key。", inUse ? "err" : "");
}

function flowLine(text: string, className = "oauth-line"): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  oauthFlow.append(p);

  return p;
}

function openPage(url: string): void {
  void chrome.tabs.create({ url, active: true });
}

function linkButton(label: string, url: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label;
  button.addEventListener("click", () => openPage(url));

  return button;
}

function onAuthEvent(event: AuthEvent): void {
  oauthFlow.hidden = false;

  if (event.type === "device_code") {
    oauthFlow.replaceChildren();
    flowLine("在打开的网页里确认登录。网页要求输入代码时，填写：");
    const code = flowLine(event.userCode, "oauth-code");
    code.id = "oauth-user-code";
    const actions = document.createElement("div");
    actions.className = "d-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn";
    copy.textContent = "复制代码";
    copy.addEventListener("click", () => { void navigator.clipboard.writeText(event.userCode).then(() => { copy.textContent = "已复制"; }); });
    actions.append(copy, linkButton("重新打开登录网页", event.verificationUri));
    oauthFlow.append(actions);
    oauthState.textContent = "等待你在网页上确认…";
    openPage(event.verificationUri);
  } else if (event.type === "auth_url") {
    flowLine(event.instructions ?? "在打开的网页里完成登录。");
    oauthFlow.append(linkButton("打开登录网页", event.url));
    openPage(event.url);
  } else if (event.type === "progress") {
    oauthState.textContent = event.message;
  } else {
    flowLine(event.message);

    for (const link of event.links ?? []) oauthFlow.append(linkButton(link.label ?? link.url, link.url));
  }
}

/** 登录流程向用户要输入（企业域名、登录方式、手动粘贴授权码）：就地显示一个输入框或几个选项。 */
function onAuthPrompt(prompt: AuthPrompt): Promise<string> {
  oauthFlow.hidden = false;
  const box = document.createElement("div");
  box.className = "oauth-prompt";
  const message = document.createElement("p");
  message.textContent = prompt.message;
  box.append(message);
  oauthFlow.append(box);

  return new Promise<string>((resolve, reject) => {
    const done = (value: string) => { box.remove(); resolve(value); };

    prompt.signal?.addEventListener("abort", () => { box.remove(); reject(new Error("已取消")); }, { once: true });

    if (prompt.type === "select") {
      for (const option of prompt.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.textContent = option.label;
        button.title = option.description ?? "";
        button.addEventListener("click", () => done(option.id));
        box.append(button);
      }

      return;
    }

    const input = document.createElement("input");
    input.className = "d-input";
    input.type = prompt.type === "secret" ? "password" : "text";
    input.placeholder = prompt.placeholder ?? "";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn";
    ok.textContent = "确定";
    ok.addEventListener("click", () => done(input.value));
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") done(input.value); });
    box.append(input, ok);
    input.focus();
  });
}

async function startLogin(): Promise<void> {
  if (!selected?.oauthLabel || login) return;
  const providerId = selected.id;
  login = new AbortController();
  oauthFlow.replaceChildren();
  oauthState.textContent = "正在向服务商申请登录代码…";
  renderCredentialState();
  const interaction: AuthInteraction = { signal: login.signal, notify: onAuthEvent, prompt: onAuthPrompt };

  try {
    await runtime.models.login(providerId, "oauth", interaction);
    oauthFlow.replaceChildren();
    oauthFlow.hidden = true;
    login = null;
    await reload();
    oauthState.textContent = "登录成功。";
  } catch (error) {
    const cancelled = login?.signal.aborted;
    login = null;
    renderCredentialState();
    oauthState.textContent = cancelled ? "已取消登录。" : `登录失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function logout(): Promise<void> {
  if (!selected) return;
  await runtime.credentials.delete(selected.id);
  await reload();
  oauthState.textContent = "已退出登录。";
}

async function saveVoiceKey(): Promise<void> {
  const key = voiceInput.value.trim();

  if (!key) return setStatus(voiceStatus, "填写 StepFun API key。", "err");
  await chrome.storage.local.set({ [INPROC_VOICE_KEY]: key });
  voiceInput.value = "";
  await reload();
  setStatus(voiceStatus, "已保存。侧栏的语音按钮现在可以用了。", "ok");
}

async function clearVoiceKey(): Promise<void> {
  await chrome.storage.local.remove(INPROC_VOICE_KEY);
  await reload();
  setStatus(voiceStatus, "已清除。", "");
}

/** 已连接服务商的模型，按服务商分组；`current` 不在其中时单独补一项，免得下拉显示空白。 */
function modelOptionGroups(current: InprocModelConfig | null): Array<HTMLOptGroupElement | HTMLOptionElement> {
  const value = (c: InprocModelConfig) => JSON.stringify({ provider: c.provider, modelId: c.modelId });
  const groups: Array<HTMLOptGroupElement | HTMLOptionElement> = [];

  for (const choice of choices) {
    if (choice.id === CUSTOM_PROVIDER_ID || !credentialNote(choice.id) || !choice.models.length) continue;
    const group = document.createElement("optgroup");
    group.label = labelOf(choice.id);
    group.append(...choice.models.map((modelId) => new Option(modelId, value({ provider: choice.id, modelId }))));
    groups.push(group);
  }

  if (current && !groups.some((g) => [...g.querySelectorAll("option")].some((o) => o.value === value(current)))) {
    groups.push(new Option(`${labelOf(current.provider)} · ${current.modelId}`, value(current)));
  }

  return groups;
}

/** 念结果只用 MiniMax 订阅 Key：MiniMax 按 Key 决定扣套餐还是按量（docs/evals/20261007-ptt-speak.md R2）。 */
async function saveSpeechKey(): Promise<void> {
  const key = speechInput.value.trim();

  if (!key) return setStatus(voiceStatus, "填写 MiniMax 订阅 Key。", "err");

  if (!isSubscriptionKey(key)) return setStatus(voiceStatus, "只接受 MiniMax Token Plan 的订阅 Key（sk-cp- 开头）。按量计费的 key 不能用。", "err");
  await chrome.storage.local.set({ [PTT_SPEECH_KEY]: key });
  speechInput.value = "";
  await reload();
  setStatus(voiceStatus, "已保存。按住说话的事做完会念出结果。", "ok");
}

async function clearSpeechKey(): Promise<void> {
  await chrome.storage.local.remove(PTT_SPEECH_KEY);
  await reload();
  setStatus(voiceStatus, "已清除，做完不再念。", "");
}

/** 主模型：只列已连接的，选了就换，不用再进服务商详情。 */
function renderMainModel(): void {
  mainSelect.replaceChildren(...config ? [] : [new Option("还没有选择", "")], ...modelOptionGroups(config));
  mainSelect.value = config ? JSON.stringify({ provider: config.provider, modelId: config.modelId }) : "";
  $("main-icon").replaceChildren(...config ? [config.provider === CUSTOM_PROVIDER_ID ? svg(Link, 15) : providerIcon(config.provider, labelOf(config.provider))] : []);
  $("main-desc").textContent = config ? labelOf(config.provider) : "在下面选一个服务商，登录或填好 key 后保存。";
}

async function saveMainModel(): Promise<void> {
  if (!mainSelect.value) return;
  // SAFETY: 选项值只由 modelOptionGroups 生成，是 {provider, modelId} 的 JSON。
  const next = JSON.parse(mainSelect.value) as InprocModelConfig;

  // 自定义地址的服务地址只存在主模型配置里：换回同一家时带上。
  if (next.provider === config?.provider && config.baseUrl) next.baseUrl = config.baseUrl;
  await chrome.storage.local.set({ [INPROC_CONFIG_KEY]: next });
  setStatus(mainStatus, `已换成 ${labelOf(next.provider)} · ${next.modelId}。侧栏接下来的任务会用它。`, "ok");
}

mainSelect.addEventListener("change", () => void saveMainModel());

/** 阶跃的文字模型每次都先思考，官方接口关不掉；用作即时动作会让解释、翻译等十几秒才出字。 */
const alwaysThinks = (c: InprocModelConfig | null) => c?.provider === STEPFUN_PROVIDER_ID;

/** 只列已填 key 或已登录的服务商的模型，选了就能用；另保留当前已存的选择。 */
function renderFastModels(): void {
  fastSelect.replaceChildren(new Option("和主模型相同", ""), ...modelOptionGroups(fastConfig));
  fastSelect.value = fastConfig ? JSON.stringify({ provider: fastConfig.provider, modelId: fastConfig.modelId }) : "";
  const slow = fastConfig ? alwaysThinks(fastConfig) : alwaysThinks(config);

  // 保存会触发存储变化、重新渲染：只增减「会很慢」的提醒，不清掉刚显示的「已保存」。
  if (slow) setStatus(fastStatus, "阶跃模型每次回答前都会先思考，解释和翻译要十几秒才出字。换一个快速模型会快很多。", "err");
  else if (fastStatus.dataset.tone === "err") setStatus(fastStatus, "");
}

async function saveFastModel(): Promise<void> {
  // SAFETY: 选项值只由 modelOptionGroups 生成，是 {provider, modelId} 的 JSON 或空串。
  const next = fastSelect.value ? (JSON.parse(fastSelect.value) as InprocModelConfig) : null;

  if (next) await chrome.storage.local.set({ [INPROC_FAST_CONFIG_KEY]: next });
  else await chrome.storage.local.remove(INPROC_FAST_CONFIG_KEY);
  fastConfig = next;
  renderFastModels();

  if (!alwaysThinks(next ?? config)) setStatus(fastStatus, next ? "已保存，下一次解释或翻译就用它。" : "已改回主模型。", "ok");
}

fastSelect.addEventListener("change", () => void saveFastModel());

async function reload(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  // SAFETY: 这个键只由本页 save() 写入，写入值就是 InprocModelConfig。
  config = (stored[INPROC_CONFIG_KEY] as InprocModelConfig | undefined) ?? null;
  // SAFETY: 这个键只由本页 saveFastModel() 写入，写入值就是 InprocModelConfig。
  fastConfig = (stored[INPROC_FAST_CONFIG_KEY] as InprocModelConfig | undefined) ?? null;
  credentials = pickCredentials(Object.entries(stored));
  await runtime.credentials.load(credentials);
  const storedVoiceKey = stored[INPROC_VOICE_KEY];
  const ownVoiceKey = isText(storedVoiceKey) ? storedVoiceKey : "";
  const voiceKey = resolveVoiceKey(Object.entries(stored));
  $("voice-state").textContent = ownVoiceKey ? `已保存 · 末四位 ${ownVoiceKey.slice(-4)}` : voiceKey ? "正在沿用阶跃星辰模型的 key，可以不填。" : "还没有 key。";
  $("voice-state").dataset.tone = voiceKey ? "ok" : "";
  voiceInput.placeholder = ownVoiceKey ? "粘贴新的 key" : "粘贴 key";
  voiceClear.hidden = !ownVoiceKey;
  const speechKey = stored[PTT_SPEECH_KEY];
  const ownSpeechKey = isText(speechKey) && isSubscriptionKey(speechKey) ? speechKey : "";
  $("speech-state").textContent = ownSpeechKey ? `已保存 · 末四位 ${ownSpeechKey.slice(-4)}` : "还没有 key，做完不念。";
  $("speech-state").dataset.tone = ownSpeechKey ? "ok" : "";
  speechInput.placeholder = ownSpeechKey ? "粘贴新的 key" : "粘贴 sk-cp- 开头的 key";
  speechClear.hidden = !ownSpeechKey;
  speakToggle.checked = stored[PTT_SPEAK_RESULT] !== false;
  renderVoiceModels(stored[INPROC_VOICE_MODEL_KEY]);
  const voice = stored[STEP_VOICE_STORAGE_KEY];
  renderTimbres(isStepVoice(voice) ? voice : DEFAULT_STEP_VOICE);
  renderOrbStyles(parseOrbStyle(stored[ORB_STYLE_STORAGE_KEY]));
  renderPersonas(parseVoicePersona(stored[VOICE_PERSONA_STORAGE_KEY]));
  selectionBar.checked = !isSelectionBarOff(stored[SELECTION_BAR_KEY]);
  linkPreview.checked = !isLinkPreviewOff(stored[LINK_PREVIEW_KEY]);
  nudgeToggle.checked = isNudgeOn(stored[NUDGE_KEY]);
  openThreads.checked = stored[OPEN_THREADS_KEY] === true;
  renderMainModel();
  renderRegions();
  renderCredentialState();
  renderProviders();
  renderFastModels();
}

search.addEventListener("input", () => renderProviders());

search.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  search.value = "";
  renderProviders();
});

addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  search.focus();
});

const timbreList = $("timbre-list");

const sample = new Audio();

/** 单选行：左边圆点 + 名字（+ 说明），整行可点。 */
function radioRow(className: string, label: string, checked: boolean, meta = ""): HTMLButtonElement {
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = `radio-hit ${className}`;
  pick.setAttribute("role", "radio");
  pick.setAttribute("aria-checked", String(checked));
  pick.append(Object.assign(document.createElement("i"), { className: "radio" }), Object.assign(document.createElement("span"), { textContent: label }));

  if (meta) pick.append(Object.assign(document.createElement("span"), { className: "radio-meta", textContent: meta }));

  return pick;
}

function renderVoiceModels(raw: unknown): void {
  let current: string | null = null;

  try { current = resolveVoiceModel(raw); } catch { /* 无效值保持未选；由用户明确纠正，不写回默认。 */ }
  $("voice-model-state").textContent = current
    ? "沿用现有阶跃星辰 key；需对应服务可用。下次开启语音时生效。"
    : "语音模型设置无效，请重新选择后再开启。";
  $("voice-model-list").replaceChildren(...[
    { model: "stepaudio-3-realtime-preview", label: "按量 Realtime 3", note: "当前默认" },
    { model: "stepaudio-2.5-realtime", label: "套餐 Realtime 2.5", note: "闲聊直接回答；网页操作交给助手" },
  ].map(option => {
    const pick = radioRow("voice-model-option", option.label, option.model === current, option.note);

    pick.dataset.model = option.model;
    pick.addEventListener("click", () => {
      void chrome.storage.local.set({ [INPROC_VOICE_MODEL_KEY]: option.model }).then(() => {
        renderVoiceModels(option.model);
        setStatus(voiceStatus, "已保存，下次开启语音时生效。", "ok");
      });
    });

    return pick;
  }));
}

function renderTimbres(current: string): void {
  timbreList.replaceChildren(...STEP_VOICES.map((voice) => {
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("timbre-option", voice.label, voice.id === current);
    pick.dataset.voice = voice.id;
    pick.addEventListener("click", () => {
      renderTimbres(voice.id);
      void chrome.storage.local.set({ [STEP_VOICE_STORAGE_KEY]: voice.id });
    });
    const listen = document.createElement("button");
    listen.type = "button";
    listen.className = "icon-btn";
    listen.append(svg(Play, 13), "试听");
    listen.setAttribute("aria-label", `试听${voice.label}`);
    listen.addEventListener("click", () => {
      sample.src = `voices/${voice.id}.m4a`;
      void sample.play();
    });
    row.append(pick, listen);

    return row;
  }));
}

const orbList = $("orb-list");

/** 光球样子：暮色、晨光带一个会动的小样（同一段视频），粒子用一个静态小圆示意。 */
function renderOrbStyles(current: OrbStyle): void {
  orbList.replaceChildren(...ORB_STYLES.map((style) => {
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("orb-option", style.label, style.id === current, style.id === "dusk" ? "默认" : undefined);
    pick.dataset.orbStyle = style.id;
    pick.addEventListener("click", () => {
      renderOrbStyles(style.id);
      void chrome.storage.local.set({ [ORB_STYLE_STORAGE_KEY]: style.id });
    });

    const thumb = style.id === "particles"
      ? Object.assign(document.createElement("span"), { className: "orb-thumb orb-thumb-particles" })
      : Object.assign(document.createElement("video"), { className: "orb-thumb", src: `orbs/${style.id}.mp4`, muted: true, loop: true, autoplay: !window.matchMedia("(prefers-reduced-motion: reduce)").matches, playsInline: true });

    thumb.setAttribute("aria-hidden", "true");
    row.append(pick, thumb);

    return row;
  }));
}

const personaList = $("persona-list");

const personaCustom = $("persona-custom");

const personaText = $<HTMLTextAreaElement>("persona-text");

const personaStatus = $("persona-status");

const personaCount = $("persona-count");

const PERSONA_OPTIONS = [...VOICE_PERSONAS.map(({ id, label, summary }) => ({ id, label, summary })), { id: "custom", label: "自定义", summary: "用你自己的描述" }] as const;

/** 预设点一下就保存；自定义先展开输入框，点保存才生效。 */
function renderPersonas(saved: VoicePersona, picked: VoicePersona["id"] = saved.id): void {
  personaList.replaceChildren(...PERSONA_OPTIONS.map((option) => {
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("persona-option", option.label, option.id === picked, option.summary);
    pick.dataset.persona = option.id;
    pick.addEventListener("click", () => {
      if (option.id === "custom") {
        renderPersonas(saved, "custom");
        personaText.focus();

        return;
      }

      void savePersona({ id: option.id });
    });
    row.append(pick);

    return row;
  }));
  personaCustom.hidden = picked !== "custom";

  if (saved.id === "custom" && document.activeElement !== personaText) personaText.value = saved.text;
  personaCount.textContent = `${personaText.value.length}/${CUSTOM_PERSONA_MAX_CHARS}`;
}

async function savePersona(persona: VoicePersona): Promise<void> {
  await chrome.storage.local.set({ [VOICE_PERSONA_STORAGE_KEY]: persona });
  renderPersonas(persona);
  setStatus(personaStatus, "已保存，下次开启语音时生效。", "ok");
}

personaText.addEventListener("input", () => { personaCount.textContent = `${personaText.value.length}/${CUSTOM_PERSONA_MAX_CHARS}`; });

$("persona-save").addEventListener("click", () => {
  const text = personaText.value.trim();

  if (!text) return setStatus(personaStatus, "先写几句你想要的性格。", "err");
  void savePersona({ id: "custom", text });
});

/** 开关一改就存；存失败时拨回去并说明。 */
function bindToggle(input: HTMLInputElement, key: string, status: HTMLElement, said: (on: boolean) => string): void {
  input.addEventListener("change", () => {
    const enabled = input.checked;

    chrome.storage.local.set({ [key]: enabled }).then(
      () => setStatus(status, said(enabled), "ok"),
      (error) => {
        input.checked = !enabled;
        setStatus(status, `没有保存：${error instanceof Error ? error.message : String(error)}`, "err");
      },
    );
  });
}

const selectionBar = $<HTMLInputElement>("selection-bar");

const selectionStatus = $("selection-status");

const linkPreview = $<HTMLInputElement>("link-preview");

const nudgeToggle = $<HTMLInputElement>("nudge");

const openThreads = $<HTMLInputElement>("open-threads");

bindToggle(selectionBar, SELECTION_BAR_KEY, selectionStatus, (on) => (on ? "已开启。" : "已关闭。"));

bindToggle(linkPreview, LINK_PREVIEW_KEY, selectionStatus, (on) => (on ? "链接预览已开启。" : "链接预览已关闭。"));

bindToggle(nudgeToggle, NUDGE_KEY, selectionStatus, (on) => (on ? "主动建议已开启。" : "主动建议已关闭。"));

bindToggle(openThreads, OPEN_THREADS_KEY, $("open-threads-status"), (on) => (on ? "已开启，下次打开新对话时出现。" : "已关闭。"));

oauthLogin.addEventListener("click", () => void startLogin());

oauthCancel.addEventListener("click", () => login?.abort());

oauthLogout.addEventListener("click", () => void logout());

$("key-change").addEventListener("click", () => {
  changingKey = true;
  renderCredentialState();
  keyInput.focus();
});

$("key-delete").addEventListener("click", () => void deleteKey());

$("model-test").addEventListener("click", () => void testConnection());

$("model-save").addEventListener("click", () => void save());

$("model-fast").addEventListener("click", () => void saveAsFast());

$("voice-save").addEventListener("click", () => void saveVoiceKey());

voiceClear.addEventListener("click", () => void clearVoiceKey());

$("speech-save").addEventListener("click", () => void saveSpeechKey());

speechInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void saveSpeechKey(); });

speechClear.addEventListener("click", () => void clearSpeechKey());

bindToggle(speakToggle, PTT_SPEAK_RESULT, voiceStatus, (on) => (on ? "做完会念出结果。" : "做完不再念。"));

// agent 在后台刷新令牌、或另一个设置页改了配置：界面跟着变。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k === INPROC_CONFIG_KEY || k === INPROC_FAST_CONFIG_KEY || k === INPROC_VOICE_KEY || k === INPROC_VOICE_MODEL_KEY || k === PTT_SPEECH_KEY || k === PTT_SPEAK_RESULT || k === STEP_VOICE_STORAGE_KEY || k === VOICE_PERSONA_STORAGE_KEY || k === SELECTION_BAR_KEY || k === LINK_PREVIEW_KEY || k === NUDGE_KEY || k === OPEN_THREADS_KEY || k.startsWith(INPROC_CREDENTIAL_PREFIX))) void reload();
});

form.remove();

await reload();

const traceStatus = document.getElementById("trace-status")!;

const download = (text: string, name: string) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
};

document.getElementById("trace-export")!.addEventListener("click", async () => {
  try {
    const exported = await exportDiagnostics();

    if (!exported.traceLines && !exported.voiceLines) {
      traceStatus.textContent = "还没有记录。";

      return;
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    if (exported.traceLines) download(exported.traces, `by-your-side-traces-${stamp}.jsonl`);

    if (exported.voiceLines) download(exported.voice, `by-your-side-voice-${stamp}.jsonl`);
    traceStatus.textContent = `已导出 ${exported.sessions} 个会话、${exported.traceLines} 条任务记录，${exported.voiceLines} 条语音记录。`;
  } catch (error) {
    traceStatus.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  }
});

document.getElementById("trace-clear")!.addEventListener("click", async () => {
  try {
    await clearDiagnostics();
    traceStatus.textContent = "已清空。";
  } catch (error) {
    traceStatus.textContent = `清空失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
