import { mountDictationSettings } from "./dictation.js";
/**
 * 模型与语音设置页：扩展的独立页面，侧栏「更多 → 模型与语音」打开。
 *
 * 只写 chrome.storage：模型选择（INPROC_CONFIG_KEY）、各家凭据（INPROC_CREDENTIAL_PREFIX）、语音密钥（INPROC_VOICE_KEY）、音色（STEP_VOICE_STORAGE_KEY）。
 * background 监听存储变化，推给扩展内 agent；这里不直接和 agent 通信。
 * 订阅登录用 pi-ai 的设备码流程，登录结果经凭据库直接落盘。
 */
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { Check, ChevronDown, ChevronRight, CircleCheck, createElement as icon, KeyRound, Link, Play, Search, X } from "lucide";
import { createModelRuntime, DEFAULT_MODELS, FEATURED_PROVIDERS, PROBE_TIMEOUT_MS, probeModel, type ProviderChoice } from "../inproc/model-runtime.js";
import {
  CUSTOM_PROVIDER_ID, INPROC_BACKUP_CONFIG_KEY, INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_FAST_CONFIG_KEY, INPROC_VOICE_KEY, INPROC_VOICE_MODEL_KEY, pickCredentials, modelCredential, resolveVoiceKey, resolveVoiceModel,
  STEPFUN_PROVIDER_ID,
  type InprocModelConfig, type StoredCredential, type StoredCredentials,
} from "../inproc/shared.js";
import { thinkingProfile } from "../../../shared/model-capabilities.js";
import { clearDiagnostics, exportDiagnostics } from "../shared/trace-store.js";
import { SELECTION_BAR_KEY, isSelectionBarOff } from "../shared/ask-selection.js";
import { LINK_PREVIEW_KEY, isLinkPreviewOff } from "../shared/link-preview.js";
import { NUDGE_KEY, isNudgeOn } from "../shared/nudge.js";
import { BROWSE_ON_KEY, isBrowseOn } from "../shared/browse-habits.js";
import { isMiniAppsOn, MINI_APPS_KEY } from "../shared/mini-apps.js";
import { isSubscriptionKey, PTT_SPEAK_RESULT, PTT_SPEECH_KEY } from "../shared/ptt.js";
import { OPEN_THREADS_KEY } from "../sidepanel/open-threads.js";
import { ATTENTION_CUES_KEY, isCuesOn } from "../shared/cues.js";
import { CUSTOM_PERSONA_MAX_CHARS, DEFAULT_STEP_VOICE, GPT_LIVE_MODEL, isStepVoice, ORB_STYLE_STORAGE_KEY, ORB_STYLES, parseOrbStyle, parseVoicePersona, STEP_VOICE_STORAGE_KEY, STEP_VOICES, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS, type OrbStyle, type VoicePersona } from "../../../shared/voice.js";
import { COLOR_TONE_KEY, COLOR_TONES, parseColorTone, syncColorTone, writeCachedTone, type ColorTone } from "../shared/color-tone.js";
import { renderSettings } from "./view.js";
import { mountSettingsNavigation } from "./navigation.js";
import { mountModelPicker } from "./model-picker.js";
import { CONNECTION_PREFIX, modelConfig, optionConfig, readConnections, rememberConnections, saveConnection, saveModelRole, withModelSettings } from "./connections.js";
import { groupEntries, matchEntry, providerIcon, type Entry } from "./providers.js";

syncColorTone();

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

renderSettings();
void mountDictationSettings();

const isText = (value: unknown): value is string => typeof value === "string";

// SAFETY: 只用于上面模板里写死的 id，调用方给的元素类型与模板标签一致。
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $("provider-form");
const connectionDialog = $<HTMLDialogElement>("connection-dialog");
const connectionHeading = $("connection-heading");
let savedConnections = new Map<string, InprocModelConfig>();
let addingConnection = false;

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
const keyReason = $("key-reason");
const keyReasonText = $("key-reason-text");
const keyRetry = $<HTMLButtonElement>("key-retry");
const testButton = $<HTMLButtonElement>("model-test");
const fastButton = $<HTMLButtonElement>("model-fast");
const saveButton = $<HTMLButtonElement>("model-save");

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

const speechStatus = $("speech-status");

const speechInput = $<HTMLInputElement>("speech-key");

const speechClear = $<HTMLButtonElement>("speech-clear");

const speakToggle = $<HTMLInputElement>("ptt-speak");

let config: InprocModelConfig | null = null;

let fastConfig: InprocModelConfig | null = null;

const fastSelect = $<HTMLSelectElement>("fast-model");

const fastStatus = $("fast-status");

let backupConfig: InprocModelConfig | null = null;

const backupSelect = $<HTMLSelectElement>("backup-model");

const backupStatus = $("backup-status");

let credentials: StoredCredentials = {};

let selected: ProviderChoice | null = null;

/** 正在编辑的服务商家族。 */
let openKey: string | null = null;

/** 已存 key 时，点了「更换」才露出输入框。 */
let changingKey = false;
/** 表单打开时自定义连接的地址；别的窗口之后改了地址，旧表单不能把新密钥带到旧地址。 */
let openedBaseUrl = "";

let login: AbortController | null = null;

/** 语音用的阶跃星辰 key 从哪来（resolveVoiceKey 的结果）：语音自己存的、借主模型的阶跃星辰 key、还没有。 */
let voiceKeySource: "own" | "model" | "" = "";

$("connection-close").append(svg(X, 16));

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

function credentialNote(providerId: string): "已登录" | "已存密钥" | "" {
  const credential = credentials[providerId];

  if (credential?.type === "oauth") return "已登录";

  if (credential?.type === "api_key" && credential.key) return "已存密钥";

  return "";
}

const connected = (entry: Entry) => entry.members.some((m) => credentialNote(m.id) || m.id === CUSTOM_PROVIDER_ID && savedConnections.has(m.id) || m.id === config?.provider);

/** 一行的状态：使用中 > 已登录 > 已存密钥。 */
interface EntryStatus { kind: "use" | "oauth" | "key" | ""; text: string; region?: string }

function entryStatus(entry: Entry): EntryStatus {
  const use = entry.members.find((m) => m.id === config?.provider);

  if (use) return { kind: "use", text: "使用中", region: use.region };

  for (const [kind, text] of [["oauth", "已登录"], ["key", "已存密钥"]] as const) {
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
  button.dataset.entryKey = entry.key;
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


  return item;
}

function groupLabel(text: string): HTMLElement {
  return Object.assign(document.createElement("div"), { className: "grp", textContent: text });
}

/** 已连接的在上（正在用的第一），自定义地址其次，其余折起；一家都没连时默认展开；搜索时只留命中的行，并展开其余。 */
function renderProviders(): void {
  const query = search.value.trim();
  const matches = entries.filter((e) => e.key !== CUSTOM_PROVIDER_ID).map((e) => [e, matchEntry(e, choices, query)] as const).filter(([, m]) => m.hit);
  const mine = matches.filter(([e]) => connected(e)).sort(([a], [b]) => Number(entryStatus(b).kind === "use") - Number(entryStatus(a).kind === "use"));
  const rest = matches.filter(([e]) => !connected(e));
  const custom = entries.find((e) => e.key === CUSTOM_PROVIDER_ID)!;
  const customHit = !query || matchEntry(custom, choices, query).hit || !matches.length;

  $("provider-connected").replaceChildren(...mine.length ? [groupLabel(`已添加 · ${mine.length}`), ...mine.map(([e, m]) => providerRow(e, m.models))] : []);
  const offered = addingConnection && query ? matches : rest;
  const subscriptions = offered.filter(([entry]) => entry.members.some(member => choiceOf(member.id)?.oauthLabel));
  const keys = offered.filter(item => !subscriptions.includes(item));
  $("provider-others").replaceChildren(
    ...subscriptions.length ? [groupLabel("订阅账号 · 登录已有账号"), ...subscriptions.map(([entry, match]) => providerRow(entry, match.models))] : [],
    ...keys.length ? [groupLabel("使用密钥 · 连接服务商"), ...keys.map(([entry, match]) => providerRow(entry, match.models))] : [],
  );
  const adding = addingConnection || !mine.length;
  $("provider-connected").hidden = addingConnection;
  more.hidden = !offered.length || !adding;
  $("connection-count").textContent = `${entries.filter(e => e.key !== CUSTOM_PROVIDER_ID && connected(e)).length} 家服务商已添加`;
  $("connection-add").textContent = addingConnection ? "返回已添加" : "添加连接";
  $("provider-more-names").replaceChildren(groupLabel(`选择服务商 · ${offered.length}`), Object.assign(document.createElement("span"), {
    className: "more-names", textContent: `${rest.slice(0, 4).map(([e]) => e.name).join("、")}${rest.length > 4 ? ` 等 ${rest.length} 家` : ""}`,
  }));

  if (adding) more.open = true;
  const empty = $("provider-empty");
  empty.hidden = (adding ? offered : mine).length > 0;
  empty.textContent = `没有找到「${query}」。OpenAI 兼容的服务可以用下面的「自定义地址」接入。`;
  $("provider-custom").replaceChildren(...customHit && (adding || connected(custom)) ? [providerRow(custom, [])] : []);


}

function closeForm(restoreFocus = true): void {
  const returnTo = openKey;
  cancelProbe();
  login?.abort();
  login = null;
  keyInput.value = "";
  if (connectionDialog.open) connectionDialog.close();
  openKey = null;
  selected = null;
  form.hidden = true;
  closeModelList();
  form.remove();
  renderProviders();
  if (restoreFocus && returnTo && !document.querySelector<HTMLElement>('[data-settings-panel="connections"]')?.hidden) {
    [...document.querySelectorAll<HTMLButtonElement>('.provider-option')].find(button => button.dataset.entryKey === returnTo)?.focus();
  }
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
  const saved = savedConnections.get(choice.id);
  if (saved) return saved.modelId;
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

  if (login === null) oauthState.textContent = loggedIn ? "已登录。" : "点登录后，会打开服务商的页面。在那个页面确认登录。";

  keySaved.hidden = !selected.apiKey || !saved || changingKey;
  keyTail.textContent = saved ? ` · 末四位 ${saved.slice(-4)}` : "";
  keyRow.hidden = !selected.apiKey || loggedIn || !!saved && !changingKey;
  $("connection-remove").hidden = selected.id !== CUSTOM_PROVIDER_ID || !savedConnections.has(CUSTOM_PROVIDER_ID);
  keyLabel.textContent = selected.id === CUSTOM_PROVIDER_ID ? "密钥（本机服务可以不填）" : selected.oauthLabel ? "或者填密钥" : "密钥";
  keyInput.placeholder = saved ? "粘贴新密钥。留空就继续用旧的。" : "粘贴密钥";
}

function select(choice: ProviderChoice): void {
  if (login) return;
  selected = choice;
  openKey = entryOf(choice.id)?.key ?? null;
  changingKey = false;
  form.hidden = false;
  saveButton.textContent = savedConnections.has(choice.id) ? "验证并更新" : "验证并保存";
  connectionHeading.textContent = labelOf(choice.id);
  connectionDialog.append(form);
  if (!connectionDialog.open) connectionDialog.showModal();
  baseUrlRow.hidden = choice.id !== CUSTOM_PROVIDER_ID;
  baseUrlInput.value = choice.id === CUSTOM_PROVIDER_ID ? savedConnections.get(CUSTOM_PROVIDER_ID)?.baseUrl ?? (config?.provider === CUSTOM_PROVIDER_ID ? config.baseUrl : "") ?? "" : "";
  openedBaseUrl = baseUrlInput.value;
  keyInput.value = "";
  modelInput.value = defaultModel(choice);
  $("model-toggle").hidden = connectionModels().length === 0;
  modelMeta.textContent = modelCount(choice);
  closeModelList();
  oauthFlow.hidden = true;
  oauthFlow.replaceChildren();
  cancelProbe();
  setStatus(modelStatus, "");
  hideKeyReason();
  renderRegions();
  renderCredentialState();
  renderProviders();
}

const modelCount = (choice: ProviderChoice) => choice.models.length ? `列表里有 ${choice.models.length} 个模型，也可以直接填模型名` : "填模型名";

/** 服务商公开清单到了就换上全量模型；拉不到时保留内置的几个，用户仍可直接填模型名。 */
void runtime.loadProviderModels().then(() => {
  for (const fresh of runtime.providerChoices()) {
    const choice = choiceOf(fresh.id);

    if (choice) choice.models = fresh.models;
  }

  if (selected) {
    $("model-toggle").hidden = connectionModels().length === 0;
    modelMeta.textContent = modelCount(selected);
    if (modelOptions.matches(":popover-open")) renderModelList();
  }

  renderProviders();
}, (error: unknown) => console.debug("[sideagent]", "provider model list unavailable", error));

/* 模型下拉：可搜索的列表，也能直接填目录外的名字（自定义地址必须能填）。 */

let modelActive = -1;

/** 打开时列出全部；输入后只留包含所输文字的。 */
let modelFilter = "";

function connectionModels(): string[] {
  const saved = selected && savedConnections.get(selected.id);
  return [...new Set([...(selected?.models ?? []), ...(saved ? [saved.modelId] : [])])];
}

function renderModelList(): void {
  const models = connectionModels();
  const query = modelFilter.toLowerCase();
  const shown = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;

  if (!shown.length) { closeModelList(); modelOptions.replaceChildren(); return; }
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
  note.textContent = !models.length ? "这个服务商没有模型列表。直接填模型名。" : !shown.length ? `列表里没有「${modelFilter}」。保存时用你填的模型名。` : `${shown.length} 个模型`;
  modelOptions.replaceChildren(note, ...rows);
}

function openModelList(): void {
  if (modelOptions.matches(":popover-open") || !selected) return;
  modelFilter = "";
  modelActive = -1;
  renderModelList();
  if (!modelOptions.children.length) return;
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
  } else if (event.key === "Escape" && modelOptions.matches(":popover-open")) {
    event.preventDefault();
    event.stopPropagation();
    closeModelList();
  }
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
    return { ok: false, error: selected.oauthLabel ? "先登录，或填密钥。" : "填密钥。" };
  }

  return { ok: true, config: next, key };
}

/** 把服务商和网络层的报错翻成用户能处理的话；原文只进「技术详情」。 */
function explainFailure(raw: string): string {
  // Kimi 套餐超过同时请求上限时回 403 permission_error，不是密钥问题。
  if (/concurrent request limit|too many concurrent/i.test(raw)) return "同时发的请求太多，服务商拒绝了这一个。等前面的请求做完再试。";

  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api.?key|token)|forbidden/i.test(raw) ? "服务商不接受这个密钥。如果密钥没错，就检查它能不能用这个模型。"
    : /\b429\b|rate.?limit|quota|insufficient|余额|额度/i.test(raw) ? "服务商拒绝了请求：额度用完或请求太频繁。稍后再试，或换一个模型。"
      : /\b404\b|model.*(not.*found|does not exist)|不存在/i.test(raw) ? "找不到这个模型，检查模型名称"
        : /connection error|failed to fetch|fetch failed|network|ECONN|ENOTFOUND/i.test(raw) ? "连不上服务商。检查网络后再试一次。"
          : "服务商返回了错误";
}

/** 试连超时的说法：「测试连接」和保存前的试连共用同一个开头和同一个时长。 */
const probeTimeoutLead = (): string => `${PROBE_TIMEOUT_MS / 1000} 秒内没有收到服务商的回复`;
const TEST_TIMEOUT_REASON = (): string => `${probeTimeoutLead()}。服务商可能正忙。再试一次，或换一个模型。`;
const SAVE_TIMEOUT_REASON = (): string => `${probeTimeoutLead()}，密钥没有保存。可能是网络或服务繁忙，稍后重试。`;

/** 试连时禁掉测试、快速模型、保存和重试按钮，免得再点出第二个并发的测试或保存。 */
function setFormBusy(busy: boolean): void {
  for (const button of [saveButton, fastButton, testButton, keyRetry]) button.disabled = busy;
}

let retryAction: (() => Promise<void>) | undefined;
/** 中止正在进行的试连：换服务商时它属于上一家，不能再写进新表单，也不能让新表单的按钮一直灰着。 */
let cancelProbe = (): void => {};

function hideKeyReason(): void {
  keyReason.hidden = true;
  keyRetry.hidden = true;
  retryAction = undefined;
  keyInput.classList.remove("warn");
}

function showKeyReason(reason: string, raw?: string, retry?: () => Promise<void>): void {
  // 密钥框不在（订阅登录、已保存的密钥）：原因写在状态行，不挂在看不见的框下面。
  if (!keyInput.offsetParent) return setStatus(modelStatus, `没有保存：${reason}`, "err", raw);
  keyReason.hidden = false;
  retryAction = retry;
  keyRetry.hidden = !retry;
  // 先显示区域再写字，读屏才会念出来。
  requestAnimationFrame(() => { keyReasonText.textContent = reason; });
  keyInput.classList.add("warn");
  setStatus(modelStatus, "", "", raw);
  keyInput.focus();
}

type ProbeOk = { ok: true; config: InprocModelConfig; key: string; elapsed: number };
/** definite：服务商明确不接受这份配置（密钥被拒、模型不存在）。超时、限流、网络、服务商自己出错都不算。 */
type ProbeFail = { ok: false; cancelled?: boolean; local?: string; reason?: string; raw?: string; definite?: boolean; timedOut?: boolean; config?: InprocModelConfig; key?: string };

function rejectsConfig(raw: string): boolean {
  if (/concurrent request limit|too many concurrent/i.test(raw)) return false;

  return /\b(401|403)\b|unauthori[sz]ed|invalid.*(api.?key|token)|api.?key.*(not valid|invalid)|API_KEY_INVALID|forbidden/i.test(raw) || /\b404\b|model.*(not.*found|does not exist)|不存在/i.test(raw);
}

async function runProbe(): Promise<ProbeOk | ProbeFail> {
  const value = draft();

  if (!value.ok) return { ok: false, local: value.error };
  if (value.config.provider === CUSTOM_PROVIDER_ID && !value.key && (savedConnections.get(CUSTOM_PROVIDER_ID)?.baseUrl ?? "") !== openedBaseUrl) {
    return { ok: false, local: "这条连接刚在别的窗口改过。关掉再打开，确认地址后再试。" };
  }
  const started = performance.now();
  hideKeyReason();
  setStatus(modelStatus, "正在测试…", "busy");
  const ticker = setInterval(() => setStatus(modelStatus, `正在测试…已等 ${Math.round((performance.now() - started) / 1000)} 秒`, "busy"), 1000);
  const probe = createModelRuntime((id, credential) => (credential?.type === "oauth" ? writeCredential(id, credential) : undefined));
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const cancel = new AbortController();
  // 只放开一次：被中止的试连稍后走到 finally 时，按钮和计时可能已经属于下一次试连。
  let live = true;
  const release = () => {
    if (!live) return;
    live = false;
    clearInterval(ticker);
    setFormBusy(false);
  };
  cancelProbe = () => { cancel.abort(); release(); };
  setFormBusy(true);

  try {
    const savedKey = credentials[value.config.provider];
    const probeCredentials = value.config.provider === CUSTOM_PROVIDER_ID || value.key
      ? { ...credentials, [value.config.provider]: modelCredential(value.config, value.key || (savedKey?.type === "api_key" ? savedKey.key ?? "" : "")) }
      : credentials;
    await probe.credentials.load(probeCredentials);
    await probeModel(probe, value.config, AbortSignal.any([timeout, cancel.signal]));

    return { ok: true, config: value.config, key: value.key, elapsed: performance.now() - started };
  } catch (error) {
    if (cancel.signal.aborted) return { ok: false, cancelled: true };
    const raw = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      reason: timeout.aborted ? TEST_TIMEOUT_REASON() : explainFailure(raw),
      timedOut: timeout.aborted,
      raw: timeout.aborted ? undefined : raw,
      definite: !timeout.aborted && rejectsConfig(raw),
      // 试的是哪份配置就存哪份：试连期间改了表单，不存没试过的值。
      config: value.config,
      key: value.key,
    };
  } finally {
    release();
  }
}

async function testConnection(): Promise<void> {
  const result = await runProbe();

  if (!result.ok && result.cancelled) return;

  if (!result.ok) {
    if (result.local) return setStatus(modelStatus, result.local, "err");
    // 只有服务商明确不接受时才挂在密钥框下；超时、限流、网络问题不是密钥的错。
    if (result.definite) return showKeyReason(result.reason ?? "服务商返回了错误", result.raw);
    return setStatus(modelStatus, `连接失败：${result.reason ?? "服务商返回了错误"}`, "err", result.raw);
  }

  hideKeyReason();
  setStatus(modelStatus, `连接正常（${(result.elapsed / 1000).toFixed(1)} 秒）。`, "ok");
}

async function save(): Promise<void> {
  const result = await runProbe();

  if (!result.ok && result.cancelled) return;

  // 先试连再保存：服务商明确不接受（密钥被拒、模型不存在）不保存；新填的密钥超时也不保存（见下）；限流、网络问题、没换密钥时的超时照样保存，并说刚才没连上。
  if (!result.ok && (result.local || result.definite)) {
    if (result.local) return setStatus(modelStatus, result.local, "err");
    return showKeyReason(result.reason ?? "服务商返回了错误", result.raw);
  }

  // 新填的密钥试连超时：不保存，说清是超时，并给「重试」。
  if (!result.ok && result.timedOut && result.key) {
    return showKeyReason(SAVE_TIMEOUT_REASON(), undefined, save);
  }

  const value = result.ok ? result : { config: result.config!, key: result.key ?? "" };

  await saveConnection(value.config, value.key);
  savedConnections.set(value.config.provider, value.config);
  if (value.config.provider === CUSTOM_PROVIDER_ID) openedBaseUrl = value.config.baseUrl ?? "";
  await reload();
  keyInput.value = "";
  changingKey = false;
  hideKeyReason();
  setStatus(mainStatus, "");

  if (result.ok) setStatus(modelStatus, `已保存连接。到模型页选择 ${value.config.modelId} 后使用。`, "ok");
  else setStatus(modelStatus, `已保存，但刚才没连上：${result.reason ?? "服务商返回了错误"}`, "err", result.raw);
}

async function disconnectProvider(): Promise<boolean> {
  if (!selected) return false;
  const id = selected.id;
  const result = await withModelSettings(async () => {
    const stored = await chrome.storage.local.get([INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY]);
    const keys = [CONNECTION_PREFIX + id];
    const notes: string[] = [];
    if (modelConfig(stored[INPROC_CONFIG_KEY])?.provider === id) { keys.push(INPROC_CONFIG_KEY); notes.push("主模型已清空，到模型页重新选一个。"); }
    if (modelConfig(stored[INPROC_FAST_CONFIG_KEY])?.provider === id) { keys.push(INPROC_FAST_CONFIG_KEY); notes.push("快速模型已改回主模型。"); }
    if (modelConfig(stored[INPROC_BACKUP_CONFIG_KEY])?.provider === id) { keys.push(INPROC_BACKUP_CONFIG_KEY); notes.push("备用模型已关闭。"); }
    await chrome.storage.local.remove(keys);
    await runtime.credentials.delete(id);
    return notes.join("");
  });
  await reload();
  setStatus(modelStatus, `连接已移除。${result}`, "ok");
  return true;
}

async function deleteKey(): Promise<void> {
  await disconnectProvider();
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
  const attempt = new AbortController();
  login = attempt;
  oauthFlow.replaceChildren();
  oauthState.textContent = "正在向服务商申请登录代码…";
  renderCredentialState();
  const interaction: AuthInteraction = { signal: attempt.signal, notify: onAuthEvent, prompt: onAuthPrompt };

  try {
    await runtime.models.login(providerId, "oauth", interaction);
    if (attempt.signal.aborted || login !== attempt) return;
    oauthFlow.replaceChildren();
    oauthFlow.hidden = true;
    login = null;
    await reload();
    oauthState.textContent = "登录成功。";
  } catch (error) {
    if (login !== attempt) return;
    const cancelled = attempt.signal.aborted;
    login = null;
    renderCredentialState();
    oauthState.textContent = cancelled ? "已取消登录。" : `登录失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function logout(): Promise<void> {
  if (await disconnectProvider()) oauthState.textContent = "已退出登录。";
}

async function saveVoiceKey(): Promise<void> {
  const key = voiceInput.value.trim();

  if (!key) return setStatus(voiceStatus, "填阶跃星辰密钥。", "err");
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
  const groups: Array<HTMLOptGroupElement | HTMLOptionElement> = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    const saved = savedConnections.get(choice.id);
    if (!credentialNote(choice.id) && !(choice.id === CUSTOM_PROVIDER_ID && saved)) continue;
    const configs: InprocModelConfig[] = choice.models.map(modelId => ({ provider: choice.id, modelId }));
    if (saved) configs.push(saved);
    for (const selected of [config, fastConfig, backupConfig]) if (selected?.provider === choice.id) configs.push(selected);
    const group = document.createElement('optgroup');
    group.label = labelOf(choice.id);
    for (const config of configs) {
      const value = JSON.stringify(config);
      if (seen.has(value)) continue;
      seen.add(value);
      const label = config.baseUrl ? `${config.modelId} · ${new URL(config.baseUrl).host}` : config.modelId;
      group.append(new Option(label, value));
    }
    if (group.children.length) groups.push(group);
  }
  if (current && !seen.has(JSON.stringify(current))) groups.push(new Option(`${labelOf(current.provider)} · ${current.modelId}`, JSON.stringify(current)));
  return groups;
}

/** 念结果只用 MiniMax 订阅 Key：MiniMax 按 Key 决定扣套餐还是按量。 */
async function saveSpeechKey(): Promise<void> {
  const key = speechInput.value.trim();

  if (!key) return setStatus(speechStatus, "填 MiniMax 订阅密钥。", "err");

  if (!isSubscriptionKey(key)) return setStatus(speechStatus, "只能用 Token Plan 订阅密钥（sk-cp- 开头）。按量计费的密钥不能用。", "err");
  await chrome.storage.local.set({ [PTT_SPEECH_KEY]: key });
  speechInput.value = "";
  await reload();
  setStatus(speechStatus, "已保存。按住说话的任务做完后，会念出结果。", "ok");
}

async function clearSpeechKey(): Promise<void> {
  await chrome.storage.local.remove(PTT_SPEECH_KEY);
  await reload();
  setStatus(speechStatus, "已清除，做完不再念。", "");
}

/** 主模型：只列已连接的，选了就换，不用再进服务商详情。 */
function renderMainModel(): void {
  const groups = modelOptionGroups(config);
  // 一家都没连时下拉里只有「还没有选择」：换成一个按钮，直接带到服务商列表。
  const none = !config && !groups.length;
  mainSelect.hidden = none;
  $("main-pick").hidden = !none;
  mainSelect.replaceChildren(...config ? [] : [new Option("还没有选择", "")], ...groups);
  mainSelect.value = config ? JSON.stringify(config) : "";
  $("main-icon").replaceChildren(...config ? [config.provider === CUSTOM_PROVIDER_ID ? svg(Link, 15) : providerIcon(config.provider, labelOf(config.provider))] : []);
  $("main-desc").textContent = config ? "对话与网页操作" : none ? "还没有连接服务商。在服务商列表里选一家，登录或填好密钥后保存。" : "在服务商列表里选一家。登录或填好密钥后保存。";
}

async function saveSelection(save: () => Promise<void>, target: HTMLElement): Promise<void> {
  try { await save(); }
  catch (error) {
    await reload();
    setStatus(target, `没有保存：${error instanceof Error ? error.message : String(error)}`, "err");
  }
}

async function saveMainModel(): Promise<void> {
  if (!mainSelect.value) return;
  const next = optionConfig(mainSelect.value);
  if (!next) return;

  await saveModelRole(INPROC_CONFIG_KEY, next);
  setStatus(mainStatus, `已保存。之后的任务用 ${labelOf(next.provider)} · ${next.modelId}。`, "ok");
}

mainSelect.addEventListener("change", () => void saveSelection(saveMainModel, mainStatus));

$("main-pick").addEventListener("click", () => {
  showPage("connections");
  addingConnection = true;
  renderProviders();
  more.open = true;
  search.scrollIntoView({ block: "start", behavior: "smooth" });
  search.focus({ preventScroll: true });
});

/** 阶跃的三个文字模型每次都先思考（10-11 实测），官方接口关不掉。 */
const alwaysThinks = (c: InprocModelConfig | null) => c?.provider === STEPFUN_PROVIDER_ID;

const THINKS_NOTE = "阶跃模型总会先想一下，解释和翻译因此会慢几秒。还嫌慢，可以选一个快速模型。";

/** 只列已存密钥或已登录的服务商的模型，选了就能用；另保留当前已存的选择。 */
function renderFastModels(): void {
  fastSelect.replaceChildren(new Option("和主模型相同", ""), ...modelOptionGroups(fastConfig));
  fastSelect.value = fastConfig ? JSON.stringify(fastConfig) : "";
  const slow = fastConfig ? alwaysThinks(fastConfig) : alwaysThinks(config);

  // 保存会触发存储变化、重新渲染：只增减「会很慢」的提醒，不清掉刚显示的「已保存」。
  if (slow) setStatus(fastStatus, THINKS_NOTE);
  else if (fastStatus.textContent === THINKS_NOTE) setStatus(fastStatus, "");
}

async function saveFastModel(): Promise<void> {
  const next = optionConfig(fastSelect.value);
  if (fastSelect.value && !next) return;

  await saveModelRole(INPROC_FAST_CONFIG_KEY, next);
  fastConfig = next;
  renderFastModels();

  if (!alwaysThinks(next ?? config)) setStatus(fastStatus, next ? "已保存，下一次解释或翻译就用它。" : "已改回主模型。", "ok");
}

fastSelect.addEventListener("change", () => void saveSelection(saveFastModel, fastStatus));

/** 备用模型和快速模型一样只列已连接的服务商；默认不用备用。 */
function renderBackupModels(): void {
  backupSelect.replaceChildren(new Option("不用备用", ""), ...modelOptionGroups(backupConfig));
  backupSelect.value = backupConfig ? JSON.stringify(backupConfig) : "";
}

async function saveBackupModel(): Promise<void> {
  const next = optionConfig(backupSelect.value);
  if (backupSelect.value && !next) return;

  await saveModelRole(INPROC_BACKUP_CONFIG_KEY, next);
  backupConfig = next;
  renderBackupModels();
  setStatus(backupStatus, next ? `已保存。如果主模型出错，就换成 ${labelOf(next.provider)} · ${next.modelId}。` : "已关闭。主模型出错时不换模型。", "ok");
}

backupSelect.addEventListener("change", () => void saveSelection(saveBackupModel, backupStatus));

/** 每家服务商拿来比的模型：日常可选的主力和它的快速版本。不在表里的服务商只测已选作主、快速、备用的那个。 */
const SPEED_MODELS: Record<string, readonly string[]> = {
  "kimi-coding": ["kimi-for-coding", "kimi-for-coding-highspeed", "k3"],
  "openai-codex": ["gpt-6-luna", "gpt-6.1-sol"],
  stepfun: ["step-5-preview", "step-3.7-flash"],
  "minimax-cn": ["MiniMax-M2.7-highspeed"],
};

const SPEED_QUESTION = "网页上写着：『会议室金桂可容纳 9 人，带投影仪。』金桂能坐 8 个人开带投影的会吗？先答「能」或「不能」，再用一句话说明。";

/** 正确答案是“能”：只看第一句，因为后面常补一句“但不能超过 9 人”。 */
function speedAnswerRight(text: string): boolean {
  const head = text.trim().split(/[，,。.!！？?\n]/)[0] ?? "";

  return /能|可以|没问题|yes/i.test(head) && !/不能|不可以|无法|^no\b/i.test(head);
}

function speedCandidates(): Array<{ config: InprocModelConfig; role: string }> {
  const out: Array<{ config: InprocModelConfig; role: string }> = [];
  const add = (c: InprocModelConfig | null, role: string) => {
    if (!c || c.provider === CUSTOM_PROVIDER_ID || out.some((o) => o.config.provider === c.provider && o.config.modelId === c.modelId)) return;
    out.push({ config: { provider: c.provider, modelId: c.modelId }, role });
  };

  add(config, "主模型");
  add(fastConfig, "快速模型");
  add(backupConfig, "备用模型");

  for (const [provider, ids] of Object.entries(SPEED_MODELS)) {
    if (credentialNote(provider)) for (const modelId of ids) add({ provider, modelId }, "");
  }

  return out;
}

async function runSpeedTest(): Promise<void> {
  const list = speedCandidates();
  const box = $("speed-results");
  const button = $<HTMLButtonElement>("speed-test");
  box.hidden = false;

  if (!list.length) {
    box.textContent = "还没有连接服务商。先在下面的服务商列表里登录或填好密钥。";
    return;
  }
  button.disabled = true;

  try {
    await measureSpeeds(list, box);
  } finally {
    button.disabled = false;
    button.textContent = "再测一次";
  }
}

/** OpenCode Go 服务端排队时，一句短回复也可能要近 30 秒；测速要等得比试连久，才不会把排队当成没开口。 */
const SPEED_TIMEOUT_MS = 60_000;

async function measureSpeeds(list: Array<{ config: InprocModelConfig; role: string }>, box: HTMLElement): Promise<void> {
  // 用的是已保存的订阅令牌：测试中刷新出的新令牌必须落盘，否则旧令牌已被轮换作废。
  const probe = createModelRuntime((id, credential) => (credential?.type === "oauth" ? writeCredential(id, credential) : undefined));
  await probe.credentials.load(credentials);
  const started = performance.now();
  const rows = list.map(({ config: c, role }) => {
    const row = document.createElement("div");
    row.className = "speed-row";
    row.dataset.model = `${c.provider}/${c.modelId}`;
    const name = Object.assign(document.createElement("span"), { className: "speed-name" });
    name.append(
      Object.assign(document.createElement("span"), { className: "speed-id", textContent: c.modelId }),
      Object.assign(document.createElement("span"), { className: "speed-meta", textContent: role ? `${role} · ${labelOf(c.provider)}` : labelOf(c.provider) }),
    );
    const bar = Object.assign(document.createElement("span"), { className: "speed-bar" });
    const result = Object.assign(document.createElement("span"), { className: "speed-result", textContent: "在问…" });
    row.append(name, bar, result);
    return { c, row, bar, result, first: null as number | null };
  });
  box.replaceChildren(...rows.map((r) => r.row));
  const longest = () => Math.max(10, ...rows.map((r) => r.first ?? 0));
  const redraw = () => rows.forEach((r) => { if (r.first != null) r.bar.style.setProperty("--w", `${(r.first / longest()) * 100}%`); });

  // 同一家的模型一个接一个测：有的套餐限制同时请求数（Kimi 回 403）；不同家之间同时测。
  const byProvider = new Map<string, typeof rows>();
  for (const r of rows) byProvider.set(r.c.provider, [...byProvider.get(r.c.provider) ?? [], r]);

  await Promise.all([...byProvider.values()].map(async (group) => {
    for (const r of group) await measureOne(r);
  }));

  async function measureOne(r: (typeof rows)[number]): Promise<void> {
    const t0 = performance.now();
    const signal = AbortSignal.timeout(SPEED_TIMEOUT_MS);
    let text = "";
    let cutShort = false;

    try {
      const model = probe.resolveModel(r.c);
      const [lowest] = thinkingProfile(model).levels;
      const stream = probe.models.streamSimple(model, { messages: [{ role: "user", content: SPEED_QUESTION, timestamp: Date.now() }] }, {
        maxTokens: 2048, signal, headers: probe.headersFor(model), sessionId: probe.sessionId,
        reasoning: lowest === "off" ? undefined : lowest,
        // 浏览器的 WebSocket 不能带请求头：ChatGPT 登录的模型直接用 SSE，和任务里一样。
        ...(model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          if (r.first == null && event.delta.trim()) { r.first = (performance.now() - t0) / 1000; redraw(); r.result.textContent = `${r.first.toFixed(1)} 秒开口…`; }
          text += event.delta;
        }

        if (event.type === "error") throw new Error(event.error.errorMessage ?? "服务商返回了错误");

        if (event.type === "done" && event.reason === "length") cutShort = true;
      }

      if (r.first == null) {
        r.row.dataset.state = "fail";
        r.result.textContent = cutShort ? "能连上，但思考太长，没来得及回答" : "能连上，但没有回答";
        return;
      }
      const right = speedAnswerRight(text);
      r.row.dataset.state = right ? "ok" : "wrong";
      r.result.textContent = `${r.first.toFixed(1)} 秒开口 · ${right ? "答对" : "答错"}`;
      r.result.title = text.trim();
    } catch (error) {
      r.row.dataset.state = "fail";

      if (signal.aborted) {
        r.result.textContent = r.first != null ? `${r.first.toFixed(1)} 秒开口 · ${SPEED_TIMEOUT_MS / 1000} 秒内没答完` : `${SPEED_TIMEOUT_MS / 1000} 秒内没开口`;
        return;
      }
      r.result.textContent = `不能用：${explainFailure(error instanceof Error ? error.message : String(error))}`;
      r.result.title = error instanceof Error ? error.message : String(error);
    }
  }

  box.append(Object.assign(document.createElement("p"), { className: "speed-note", textContent: `共用 ${((performance.now() - started) / 1000).toFixed(0)} 秒。同一个模型每次快慢会差好几秒，拿不准就再测一次。` }));
}

$("speed-test").addEventListener("click", () => void runSpeedTest());

async function reload(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  config = modelConfig(stored[INPROC_CONFIG_KEY]);
  fastConfig = modelConfig(stored[INPROC_FAST_CONFIG_KEY]);
  backupConfig = modelConfig(stored[INPROC_BACKUP_CONFIG_KEY]);
  savedConnections = readConnections(stored);
  await rememberConnections([config, fastConfig, backupConfig], savedConnections);
  for (const current of [config, fastConfig, backupConfig]) if (current && !savedConnections.has(current.provider)) savedConnections.set(current.provider, current);
  credentials = pickCredentials(Object.entries(stored));
  await runtime.credentials.load(credentials);
  const storedVoiceKey = stored[INPROC_VOICE_KEY];
  const ownVoiceKey = isText(storedVoiceKey) ? storedVoiceKey : "";
  const voiceKey = resolveVoiceKey(Object.entries(stored));
  voiceKeySource = ownVoiceKey ? "own" : voiceKey ? "model" : "";
  $("voice-key-note").textContent = voiceKeySource === "model" ? "正在用阶跃星辰模型的密钥，下面的密钥可以不填。"
    : voiceKeySource === "own" ? "" : "下面的密钥只给语音用。主模型的密钥在服务商列表里填。";
  $("voice-state").textContent = ownVoiceKey ? `已保存 · 末四位 ${ownVoiceKey.slice(-4)}` : voiceKey ? "正在用阶跃星辰模型的密钥，可以不填。" : "还没有密钥。";
  $("voice-state").dataset.tone = voiceKey ? "ok" : "";
  voiceInput.placeholder = ownVoiceKey ? "粘贴新密钥" : "粘贴密钥";
  voiceClear.hidden = !ownVoiceKey;
  const speechKey = stored[PTT_SPEECH_KEY];
  const ownSpeechKey = isText(speechKey) && isSubscriptionKey(speechKey) ? speechKey : "";
  $("speech-state").textContent = ownSpeechKey ? `已保存 · 末四位 ${ownSpeechKey.slice(-4)}` : "还没有密钥，做完不念。";
  $("speech-state").dataset.tone = ownSpeechKey ? "ok" : "";
  speechInput.placeholder = ownSpeechKey ? "粘贴新密钥" : "粘贴 sk-cp- 开头的密钥";
  speechClear.hidden = !ownSpeechKey;
  speakToggle.checked = stored[PTT_SPEAK_RESULT] !== false;
  renderVoiceModels(stored[INPROC_VOICE_MODEL_KEY]);
  const voice = stored[STEP_VOICE_STORAGE_KEY];
  renderTimbres(isStepVoice(voice) ? voice : DEFAULT_STEP_VOICE);
  renderOrbStyles(parseOrbStyle(stored[ORB_STYLE_STORAGE_KEY]));
  renderColorTones(parseColorTone(stored[COLOR_TONE_KEY]));
  renderPersonas(parseVoicePersona(stored[VOICE_PERSONA_STORAGE_KEY]));
  selectionBar.checked = !isSelectionBarOff(stored[SELECTION_BAR_KEY]);
  linkPreview.checked = !isLinkPreviewOff(stored[LINK_PREVIEW_KEY]);
  nudgeToggle.checked = isNudgeOn(stored[NUDGE_KEY]);
  $<HTMLInputElement>("browse-habits").checked = isBrowseOn(stored[BROWSE_ON_KEY]);
  $<HTMLInputElement>("mini-apps").checked = isMiniAppsOn(stored[MINI_APPS_KEY]);
  openThreads.checked = stored[OPEN_THREADS_KEY] === true;
  attentionCues.checked = isCuesOn(stored[ATTENTION_CUES_KEY]);
  renderMainModel();
  renderRegions();
  renderCredentialState();
  renderProviders();
  renderFastModels();
  renderBackupModels();
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

/** 当前语音模型；音色和阶跃星辰密钥只对阶跃星辰的模型有意义。 */
let voiceModel: string | null = null;

function renderVoiceModels(raw: unknown): void {
  let current: string | null = null;

  try { current = resolveVoiceModel(raw); } catch { /* 无效值保持未选；由用户明确纠正，不写回默认。 */ }
  voiceModel = current;
  $("voice-key-row").hidden = current === GPT_LIVE_MODEL;
  $("voice-key-note").hidden = current === GPT_LIVE_MODEL;
  $("voice-model-state").textContent = !current ? "没有读到语音模型。重新选一个，再开启语音。"
    : current === GPT_LIVE_MODEL ? "这个语音模型用 ChatGPT 账号，不用阶跃星辰密钥。先在服务商列表里用 ChatGPT 登录。下次开启语音时生效。"
    : voiceKeySource === "model" ? "用阶跃星辰模型的密钥。下次开启语音时生效。"
    : voiceKeySource === "own" ? "用语音那一行保存的阶跃星辰密钥。下次开启语音时生效。"
    : "要先有阶跃星辰密钥。填在「阶跃星辰密钥（语音用）」，或在服务商列表里连接阶跃星辰。下次开启语音时生效。";
  $("voice-model-list").replaceChildren(...[
    { model: "stepaudio-3-realtime-preview", label: "按量 Realtime 3", note: "当前默认" },
    { model: "stepaudio-2.5-realtime", label: "套餐 Realtime 2.5", note: "闲聊由语音模型回答。页面操作交给助手。" },
    { model: GPT_LIVE_MODEL, label: "GPT-Live（ChatGPT 登录）", note: "闲聊由语音模型回答。页面操作交给助手。" },
  ].map(option => {
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("voice-model-option", option.label, option.model === current, option.note);

    pick.dataset.model = option.model;
    pick.addEventListener("click", () => {
      void chrome.storage.local.set({ [INPROC_VOICE_MODEL_KEY]: option.model }).then(() => {
        renderVoiceModels(option.model);
        setStatus(voiceStatus, "已保存，下次开启语音时生效。", "ok");
      });
    });
    row.append(pick);

    return row;
  }));
}

function renderTimbres(current: string): void {
  // GPT-Live 的声音在建连时写死为 cove（voice-client.ts），没有可选项。
  if (voiceModel === GPT_LIVE_MODEL) {
    $("timbre-desc").textContent = "GPT-Live 只有一种声音。换成阶跃星辰的模型才能选音色。";
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("timbre-option", "Cove", true, "GPT-Live 自带");
    pick.disabled = true;
    row.append(pick);
    timbreList.replaceChildren(row);

    return;
  }
  $("timbre-desc").textContent = "阶跃星辰的声音。点一下就换，下次开启语音时生效。";
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
const toneList = $("tone-list");

function renderColorTones(current: ColorTone): void {
  toneList.replaceChildren(...COLOR_TONES.map((tone) => {
    const row = document.createElement("div");
    row.className = "radio-row";
    const pick = radioRow("tone-option", tone.label, tone.id === current, tone.summary);
    pick.dataset.toneOption = tone.id;
    pick.addEventListener("click", () => {
      document.documentElement.dataset.tone = tone.id;
      writeCachedTone(tone.id);
      renderColorTones(tone.id);
      void chrome.storage.local.set({ [COLOR_TONE_KEY]: tone.id });
    });
    const preview = document.createElement("span");
    preview.className = "tone-preview";
    preview.dataset.tonePreview = tone.id;
    preview.setAttribute("aria-hidden", "true");
    pick.prepend(preview);
    row.append(pick);

    return row;
  }));
}

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
  setStatus(personaStatus, "已保存，下次语音对话生效。", "ok");
}

personaText.addEventListener("input", () => { personaCount.textContent = `${personaText.value.length}/${CUSTOM_PERSONA_MAX_CHARS}`; });

$("persona-save").addEventListener("click", () => {
  const text = personaText.value.trim();

  if (!text) return setStatus(personaStatus, "先写几句你想要的语气和措辞。", "err");
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

const attentionCues = $<HTMLInputElement>("attention-cues");

bindToggle(selectionBar, SELECTION_BAR_KEY, selectionStatus, (on) => (on ? "已开启。" : "已关闭。"));

// 划词快捷键按用户实际设的写（可在 chrome://extensions/shortcuts 改）；getAll 给的已是本系统的写法，如 Ctrl+J、⌘J。
void chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === "ask-selection")?.shortcut;
  $("ask-shortcut-note").textContent = shortcut ? `关掉后按 ${shortcut} 或右键「问 By Your Side」仍然可用。`
    : "关掉后右键「问 By Your Side」仍然可用。快捷键还没有设置，可以在 chrome://extensions/shortcuts 里给「问选中的文字」设一个。";
});

bindToggle(linkPreview, LINK_PREVIEW_KEY, selectionStatus, (on) => (on ? "链接预览已开启。" : "链接预览已关闭。"));

bindToggle(nudgeToggle, NUDGE_KEY, selectionStatus, (on) => (on ? "主动建议已开启。" : "主动建议已关闭。"));

bindToggle($<HTMLInputElement>("browse-habits"), BROWSE_ON_KEY, $("habits-status"), (on) => (on ? "已开启。" : "已暂停，已记的操作保留。"));
bindToggle($<HTMLInputElement>("mini-apps"), MINI_APPS_KEY, $("labs-status"), (on) => (on ? "已打开，下一个问题起生效。" : "已关闭，已有的小程序不再显示。"));

bindToggle(openThreads, OPEN_THREADS_KEY, $("open-threads-status"), (on) => (on ? "已开启，下次打开新对话时出现。" : "已关闭。"));

bindToggle(attentionCues, ATTENTION_CUES_KEY, $("cues-status"), (on) => (on ? "已开启。" : "已关闭。"));

oauthLogin.addEventListener("click", () => void startLogin());

oauthCancel.addEventListener("click", () => login?.abort());

oauthLogout.addEventListener("click", () => void logout());

$("key-change").addEventListener("click", () => {
  changingKey = true;
  renderCredentialState();
  keyInput.focus();
});

$("key-delete").addEventListener("click", () => void deleteKey());
$("connection-remove").addEventListener("click", () => void deleteKey());

keyInput.addEventListener("input", () => hideKeyReason());

testButton.addEventListener("click", () => void testConnection());

keyRetry.addEventListener("click", () => void retryAction?.());

saveButton.addEventListener("click", () => void save());

fastButton.addEventListener("click", () => { showPage("models"); document.getElementById("main-model-picker")?.focus(); });

$("voice-save").addEventListener("click", () => void saveVoiceKey());

voiceClear.addEventListener("click", () => void clearVoiceKey());

$("speech-save").addEventListener("click", () => void saveSpeechKey());

speechInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void saveSpeechKey(); });

speechClear.addEventListener("click", () => void clearSpeechKey());

bindToggle(speakToggle, PTT_SPEAK_RESULT, speechStatus, (on) => (on ? "做完会念出结果。" : "做完不再念。"));

// agent 在后台刷新令牌、或另一个设置页改了配置：界面跟着变。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k === INPROC_CONFIG_KEY || k === INPROC_FAST_CONFIG_KEY || k === INPROC_BACKUP_CONFIG_KEY || k === INPROC_VOICE_KEY || k === INPROC_VOICE_MODEL_KEY || k === PTT_SPEECH_KEY || k === PTT_SPEAK_RESULT || k === STEP_VOICE_STORAGE_KEY || k === VOICE_PERSONA_STORAGE_KEY || k === SELECTION_BAR_KEY || k === LINK_PREVIEW_KEY || k === NUDGE_KEY || k === OPEN_THREADS_KEY || k === ATTENTION_CUES_KEY || k === COLOR_TONE_KEY || k === ORB_STYLE_STORAGE_KEY || k === BROWSE_ON_KEY || k === MINI_APPS_KEY || k.startsWith(CONNECTION_PREFIX) || k.startsWith(INPROC_CREDENTIAL_PREFIX))) void reload();
});

const showPage = mountSettingsNavigation(() => closeForm(false));
$("connection-close").addEventListener("click", () => closeForm());
connectionDialog.addEventListener("cancel", () => closeForm());
connectionDialog.addEventListener("close", () => { if (selected && !connectionDialog.open) closeForm(); });
$("connection-add").addEventListener("click", () => {
  addingConnection = !addingConnection;
  search.value = "";
  renderProviders();
  if (addingConnection) search.focus();
});
for (const select of [mainSelect, fastSelect, backupSelect]) mountModelPicker(select, value => {
  const config = optionConfig(value);
  return config ? config.provider === CUSTOM_PROVIDER_ID ? svg(Link, 14) : providerIcon(config.provider, labelOf(config.provider)) : null;
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
