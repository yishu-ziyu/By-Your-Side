/**
 * 模型与语音设置页：扩展的独立页面，侧栏「更多 → 模型与语音」打开。
 *
 * 只写 chrome.storage：模型选择（INPROC_CONFIG_KEY）、各家凭据（INPROC_CREDENTIAL_PREFIX）、语音密钥（INPROC_VOICE_KEY）、音色（STEP_VOICE_STORAGE_KEY）。
 * background 监听存储变化，推给扩展内 agent；这里不直接和 agent 通信。
 * 订阅登录用 pi-ai 的设备码流程，登录结果经凭据库直接落盘。
 */
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import { createModelRuntime, FEATURED_PROVIDERS, type ProviderChoice } from "../inproc/model-runtime.js";
import {
  CUSTOM_PROVIDER_ID, INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_VOICE_KEY, pickCredentials, resolveVoiceKey,
  type InprocModelConfig, type StoredCredential, type StoredCredentials,
} from "../inproc/shared.js";
import { TRACE_SESSIONS_KEPT } from "../../../shared/run-trace-core.js";
import { clearTraces, exportTraces } from "../shared/trace-store.js";
import { CUSTOM_PERSONA_MAX_CHARS, DEFAULT_STEP_VOICE, isStepVoice, parseVoicePersona, STEP_VOICE_STORAGE_KEY, STEP_VOICES, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS, type VoicePersona } from "../../../shared/voice.js";

/** 实测 OpenCode Go 一个两字回复要 3–29 秒（服务端排队），30 秒会误判。 */
const TEST_TIMEOUT_MS = 60_000;

async function writeCredential(providerId: string, credential: Credential | StoredCredential | undefined): Promise<void> {
  const key = `${INPROC_CREDENTIAL_PREFIX}${providerId}`;

  if (credential) await chrome.storage.local.set({ [key]: credential });
  else await chrome.storage.local.remove(key);
}

/** 登录与保存用它：凭据一改就落盘。 */
const runtime = createModelRuntime(writeCredential);

const CUSTOM_CHOICE: ProviderChoice = { id: CUSTOM_PROVIDER_ID, name: "自定义地址", apiKey: true, models: [] };

const choices = [...runtime.providerChoices(), CUSTOM_CHOICE];

const featuredIds = new Set([...FEATURED_PROVIDERS.map((p) => p.id), CUSTOM_PROVIDER_ID]);

document.getElementById("settings")!.innerHTML = `
  <header class="settings-head">
    <img src="icons/brand-mark.svg" alt="" />
    <h1>模型与语音</h1>
  </header>
  <p id="model-current" class="settings-current"></p>
  <section class="settings-card" aria-labelledby="model-title">
    <h2 id="model-title">模型</h2>
    <p class="settings-sub">用你自己的套餐调用模型。密钥只保存在这个浏览器里。</p>
    <div id="provider-featured" class="provider-grid" role="radiogroup" aria-label="常用服务商"></div>
    <details id="provider-more">
      <summary>更多服务商</summary>
      <div id="provider-others" class="provider-list" role="radiogroup" aria-label="更多服务商"></div>
    </details>
    <div id="provider-form" hidden>
      <h3 id="provider-name"></h3>
      <div id="oauth-row" class="settings-field" hidden>
        <div class="settings-inline">
          <button id="oauth-login" type="button" class="settings-primary"></button>
          <button id="oauth-cancel" type="button" hidden>取消登录</button>
          <button id="oauth-logout" type="button" hidden>退出登录</button>
        </div>
        <p id="oauth-state" class="settings-hint"></p>
        <div id="oauth-flow" class="oauth-flow" hidden></div>
      </div>
      <label id="base-url-row" class="settings-field" hidden>
        <span>服务地址（OpenAI 兼容）</span>
        <input id="base-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/v1" />
      </label>
      <label id="key-row" class="settings-field">
        <span id="key-label">API key</span>
        <input id="api-key" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <label class="settings-field">
        <span>模型</span>
        <input id="model-id" list="model-options" autocomplete="off" spellcheck="false" />
        <datalist id="model-options"></datalist>
      </label>
      <div class="settings-inline">
        <button id="model-test" type="button">测试连接</button>
        <button id="model-save" type="button" class="settings-primary">保存并使用</button>
      </div>
      <p id="model-status" class="settings-status" role="status" aria-live="polite"></p>
    </div>
  </section>
  <section class="settings-card" aria-labelledby="voice-title">
    <h2 id="voice-title">实时语音</h2>
    <p class="settings-sub">语音对话使用阶跃星辰的实时语音。上面模型选了阶跃星辰并填了 key 的话，这里不用再填。</p>
    <label class="settings-field">
      <span>StepFun API key</span>
      <input id="voice-key" type="password" autocomplete="off" spellcheck="false" />
    </label>
    <div class="settings-inline">
      <button id="voice-save" type="button" class="settings-primary">保存</button>
      <button id="voice-clear" type="button" hidden>清除</button>
    </div>
    <p id="voice-status" class="settings-status" role="status" aria-live="polite"></p>
    <h3 id="timbre-title">音色</h3>
    <p class="settings-sub">点一下就换，下次开启语音时生效。</p>
    <div id="timbre-list" class="timbre-list" role="radiogroup" aria-labelledby="timbre-title"></div>
    <h3 id="persona-title">人设</h3>
    <p class="settings-sub">只改变语音的语气和措辞；如实汇报、不乱问这些规则不受影响。下次开启语音时生效。</p>
    <div id="persona-list" class="timbre-list" role="radiogroup" aria-labelledby="persona-title"></div>
    <div id="persona-custom" class="settings-field" hidden>
      <textarea id="persona-text" rows="3" maxlength="${CUSTOM_PERSONA_MAX_CHARS}" placeholder="用几句话描述你想要的性格，比如：说话干脆，带点幽默"></textarea>
      <div class="settings-inline">
        <button id="persona-save" type="button" class="settings-primary">保存</button>
        <span id="persona-count" class="settings-hint"></span>
      </div>
    </div>
    <p id="persona-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="settings-card" aria-labelledby="trace-title">
    <h2 id="trace-title">诊断记录</h2>
    <p class="settings-sub">每次任务的步骤、耗时和页面文字留在这台电脑的浏览器里（密码、密钥已去掉），只保留最近 ${TRACE_SESSIONS_KEPT} 个会话，不会上传。排查问题时导出给开发者。</p>
    <div class="settings-inline">
      <button id="trace-export" type="button" class="settings-primary">导出</button>
      <button id="trace-clear" type="button">清空</button>
    </div>
    <p id="trace-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
`;

const isText = (value: unknown): value is string => typeof value === "string";

// SAFETY: 只用于上面模板里写死的 id，调用方给的元素类型与模板标签一致。
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $("provider-form");

const providerName = $("provider-name");

const oauthRow = $("oauth-row");

const oauthLogin = $<HTMLButtonElement>("oauth-login");

const oauthCancel = $<HTMLButtonElement>("oauth-cancel");

const oauthLogout = $<HTMLButtonElement>("oauth-logout");

const oauthState = $("oauth-state");

const oauthFlow = $("oauth-flow");

const baseUrlRow = $("base-url-row");

const baseUrlInput = $<HTMLInputElement>("base-url");

const keyRow = $("key-row");

const keyLabel = $("key-label");

const keyInput = $<HTMLInputElement>("api-key");

const modelInput = $<HTMLInputElement>("model-id");

const modelOptions = $<HTMLDataListElement>("model-options");

const modelStatus = $("model-status");

const voiceInput = $<HTMLInputElement>("voice-key");

const voiceClear = $<HTMLButtonElement>("voice-clear");

const voiceStatus = $("voice-status");

let config: InprocModelConfig | null = null;

let credentials: StoredCredentials = {};

let selected: ProviderChoice | null = null;

let login: AbortController | null = null;

function setStatus(el: HTMLElement, text: string, tone: "ok" | "err" | "busy" | "" = ""): void {
  el.textContent = text;
  el.dataset.tone = tone;
}

function labelOf(providerId: string): string {
  return choices.find((c) => c.id === providerId)?.name ?? providerId;
}

function renderCurrent(): void {
  const el = $("model-current");

  el.textContent = config ? `正在使用：${labelOf(config.provider)} · ${config.modelId}` : "还没有选择模型。选一个服务商，填好 key 或登录后保存。";
  el.dataset.tone = config ? "ok" : "";
}

function providerButton(choice: ProviderChoice): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "provider-option";
  button.dataset.provider = choice.id;
  button.setAttribute("role", "radio");
  const name = document.createElement("span");
  name.className = "provider-option-name";
  name.textContent = choice.name;
  const note = document.createElement("span");
  note.className = "provider-option-note";
  button.append(name, note);
  button.addEventListener("click", () => select(choice));

  return button;
}

function renderProviders(): void {
  const featured = $("provider-featured");
  const others = $("provider-others");
  const featuredButtons: HTMLButtonElement[] = [];
  const otherButtons: HTMLButtonElement[] = [];

  for (const choice of choices) (featuredIds.has(choice.id) ? featuredButtons : otherButtons).push(providerButton(choice));
  featured.replaceChildren(...featuredButtons);
  others.replaceChildren(...otherButtons);
  refreshProviderMarks();
}

function credentialNote(providerId: string): string {
  const credential = credentials[providerId];

  if (credential?.type === "oauth") return "已登录";

  if (credential?.type === "api_key" && credential.key) return "已填 key";

  return "";
}

function refreshProviderMarks(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".provider-option[data-provider]")) {
    const id = button.dataset.provider!;
    button.setAttribute("aria-checked", String(selected?.id === id));
    button.classList.toggle("in-use", config?.provider === id);
    const note = config?.provider === id ? `使用中 · ${credentialNote(id) || "未配置凭据"}` : credentialNote(id);
    button.querySelector(".provider-option-note")!.textContent = note;
  }
}

function defaultModel(choice: ProviderChoice): string {
  if (config?.provider === choice.id) return config.modelId;

  return FEATURED_PROVIDERS.find((p) => p.id === choice.id)?.defaultModel ?? choice.models[0] ?? "";
}

function renderCredentialState(): void {
  if (!selected) return;
  const credential = credentials[selected.id];
  const loggedIn = credential?.type === "oauth";

  oauthRow.hidden = !selected.oauthLabel;
  oauthLogin.textContent = loggedIn ? "重新登录" : selected.oauthLabel ?? "";
  oauthLogin.hidden = login !== null;
  oauthCancel.hidden = login === null;
  oauthLogout.hidden = !loggedIn || login !== null;

  if (login === null) oauthState.textContent = loggedIn ? "已登录，令牌会自动续期。" : "用设备码登录：会打开服务商的网页，在那里确认即可。";

  keyRow.hidden = !selected.apiKey;
  keyLabel.textContent = selected.oauthLabel ? "或者填写 API key" : "API key";
  const saved = credential?.type === "api_key" && credential.key ? credential.key : "";
  keyInput.placeholder = saved ? `已保存（末四位 ${saved.slice(-4)}），留空则沿用` : selected.id === CUSTOM_PROVIDER_ID ? "本机服务可以不填" : "粘贴 key";
}

function select(choice: ProviderChoice): void {
  if (login) return;
  selected = choice;
  form.hidden = false;
  providerName.textContent = choice.name;
  baseUrlRow.hidden = choice.id !== CUSTOM_PROVIDER_ID;
  baseUrlInput.value = choice.id === CUSTOM_PROVIDER_ID ? config?.baseUrl ?? "" : "";
  keyInput.value = "";
  modelInput.value = defaultModel(choice);
  modelOptions.replaceChildren(...choice.models.map((id) => Object.assign(document.createElement("option"), { value: id })));
  oauthFlow.hidden = true;
  oauthFlow.replaceChildren();
  setStatus(modelStatus, "");
  renderCredentialState();
  refreshProviderMarks();

  if (!featuredIds.has(choice.id)) $<HTMLDetailsElement>("provider-more").open = true;
}

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

/** 把服务商和网络层的报错翻成用户能处理的话，原文放在括号里便于排查。 */
function explainFailure(raw: string): string {
  const hint = /\b(401|403)\b|unauthori[sz]ed|invalid.*(api.?key|token)|forbidden/i.test(raw) ? "key 无效，或这个 key 没有该模型的权限"
    : /\b429\b|rate.?limit|quota|insufficient|余额|额度/i.test(raw) ? "额度用完或请求太频繁，可以稍后再试或换个模型"
      : /\b404\b|model.*(not.*found|does not exist)|不存在/i.test(raw) ? "找不到这个模型，检查模型名称"
        : /connection error|failed to fetch|fetch failed|network|ECONN|ENOTFOUND/i.test(raw) ? "连不上服务商（网络中断或对方没有响应），可以再试一次"
          : "";

  return hint ? `${hint}（${raw.slice(0, 160)}）` : raw;
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
  const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);

  try {
    await probe.credentials.load(value.key ? { ...credentials, [value.config.provider]: { type: "api_key", key: value.key } } : credentials);
    const model = probe.resolveModel(value.config);

    const reply = await probe.models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }],
    }, { maxTokens: 256, signal: timeout, headers: probe.headersFor(model), sessionId: probe.sessionId });

    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "服务商返回错误");
    setStatus(modelStatus, `连接正常（${((performance.now() - started) / 1000).toFixed(1)} 秒）。`, "ok");
  } catch (error) {
    const reason = timeout.aborted ? `${TEST_TIMEOUT_MS / 1000} 秒内没有收到完整回复，服务商可能正忙，可以再试一次或换个模型` : explainFailure(error instanceof Error ? error.message : String(error));
    setStatus(modelStatus, `连接失败：${reason}`, "err");
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
  setStatus(modelStatus, `已保存。侧栏接下来的任务会使用 ${labelOf(value.config.provider)} · ${value.config.modelId}。`, "ok");
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
    actions.className = "settings-inline";
    const copy = document.createElement("button");
    copy.type = "button";
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
        button.textContent = option.label;
        button.title = option.description ?? "";
        button.addEventListener("click", () => done(option.id));
        box.append(button);
      }

      return;
    }

    const input = document.createElement("input");
    input.type = prompt.type === "secret" ? "password" : "text";
    input.placeholder = prompt.placeholder ?? "";
    const ok = document.createElement("button");
    ok.type = "button";
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

async function reload(): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  // SAFETY: 这个键只由本页 save() 写入，写入值就是 InprocModelConfig。
  config = (stored[INPROC_CONFIG_KEY] as InprocModelConfig | undefined) ?? null;
  credentials = pickCredentials(Object.entries(stored));
  await runtime.credentials.load(credentials);
  const storedVoiceKey = stored[INPROC_VOICE_KEY];
  const ownVoiceKey = isText(storedVoiceKey) ? storedVoiceKey : "";
  const voiceKey = resolveVoiceKey(Object.entries(stored));
  voiceInput.placeholder = ownVoiceKey ? `已保存（末四位 ${ownVoiceKey.slice(-4)}）` : voiceKey ? "正在沿用阶跃星辰模型的 key，可以不填" : "粘贴 key";
  voiceClear.hidden = !ownVoiceKey;
  const voice = stored[STEP_VOICE_STORAGE_KEY];
  renderTimbres(isStepVoice(voice) ? voice : DEFAULT_STEP_VOICE);
  renderPersonas(parseVoicePersona(stored[VOICE_PERSONA_STORAGE_KEY]));
  renderCurrent();
  refreshProviderMarks();
  renderCredentialState();
}

const timbreList = $("timbre-list");

const sample = new Audio();

function renderTimbres(current: string): void {
  timbreList.replaceChildren(...STEP_VOICES.map((voice) => {
    const row = document.createElement("div");
    row.className = "timbre-row";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "provider-option timbre-option";
    pick.dataset.voice = voice.id;
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(voice.id === current));
    pick.textContent = voice.label;
    pick.addEventListener("click", () => {
      renderTimbres(voice.id);
      void chrome.storage.local.set({ [STEP_VOICE_STORAGE_KEY]: voice.id });
    });
    const listen = document.createElement("button");
    listen.type = "button";
    listen.textContent = "试听";
    listen.setAttribute("aria-label", `试听${voice.label}`);
    listen.addEventListener("click", () => {
      sample.src = `voices/${voice.id}.m4a`;
      void sample.play();
    });
    row.append(pick, listen);

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
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "provider-option persona-option";
    pick.dataset.persona = option.id;
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(option.id === picked));
    const name = document.createElement("span");
    name.className = "provider-option-name";
    name.textContent = option.label;
    const note = document.createElement("span");
    note.className = "provider-option-note";
    note.textContent = option.summary;
    pick.append(name, note);
    pick.addEventListener("click", () => {
      if (option.id === "custom") {
        renderPersonas(saved, "custom");
        personaText.focus();

        return;
      }

      void savePersona({ id: option.id });
    });

    return pick;
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

oauthLogin.addEventListener("click", () => void startLogin());

oauthCancel.addEventListener("click", () => login?.abort());

oauthLogout.addEventListener("click", () => void logout());

$("model-test").addEventListener("click", () => void testConnection());

$("model-save").addEventListener("click", () => void save());

$("voice-save").addEventListener("click", () => void saveVoiceKey());

voiceClear.addEventListener("click", () => void clearVoiceKey());

// agent 在后台刷新令牌、或另一个设置页改了配置：界面跟着变。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k === INPROC_CONFIG_KEY || k === INPROC_VOICE_KEY || k === STEP_VOICE_STORAGE_KEY || k === VOICE_PERSONA_STORAGE_KEY || k.startsWith(INPROC_CREDENTIAL_PREFIX))) void reload();
});

renderProviders();

await reload();

const initial = choices.find((c) => c.id === config?.provider);

if (initial) select(initial);

const traceStatus = document.getElementById("trace-status")!;

document.getElementById("trace-export")!.addEventListener("click", async () => {
  try {
    const { text, sessions, lines } = await exportTraces();

    if (!lines) {
      traceStatus.textContent = "还没有记录。";

      return;
    }

    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
    link.download = `by-your-side-traces-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
    traceStatus.textContent = `已导出 ${sessions} 个会话、${lines} 条记录。`;
  } catch (error) {
    traceStatus.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  }
});

document.getElementById("trace-clear")!.addEventListener("click", async () => {
  try {
    await clearTraces();
    traceStatus.textContent = "已清空。";
  } catch (error) {
    traceStatus.textContent = `清空失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
