import { openRealtimeDictation } from "../shared/dictation-realtime.js";
import { DICTATION_CONFIG_KEY, DICTATION_KEY_PREFIX, DICTATION_PROVIDERS, isDictationProvider, readDictationSettings, readVoiceDictationKey, type DictationProvider } from "../shared/dictation-config.js";
import { dictationWav, transcribeDictation } from "../shared/dictation-service.js";

export const dictationSettingsView = `
  <section class="sx" aria-labelledby="dictation-title">
    <div class="sx-head"><h2 id="dictation-title">语音转文字</h2><p class="sx-sub">左侧麦克风用来输入文字，确认后留在输入框，由你发送。</p></div>
    <div class="surface rows">
      <label class="row"><span class="row-main"><span class="row-title">识别服务</span><span id="dictation-description" class="row-desc"></span></span><span class="row-ctl"><select id="dictation-provider" class="sel" aria-label="语音转文字识别服务">${Object.entries(DICTATION_PROVIDERS).map(([id, info]) => `<option value="${id}">${info.name}</option>`).join("")}</select></span></label>
      <label id="dictation-source-row" class="row" hidden><span class="row-main"><span class="row-title">密钥来源</span><span id="dictation-key-source-note" class="row-desc"></span></span><span class="row-ctl"><select id="dictation-key-source" class="sel" aria-label="听写密钥来源"><option value="own">单独填写</option><option value="voice">沿用语音对话密钥</option></select></span></label>
      <label id="dictation-key-row" class="row" hidden><span class="row-main"><span id="dictation-key-label" class="row-title">识别服务密钥</span><span class="row-desc">仅用于左侧麦克风。留空并保存可清除已存密钥。</span></span><span class="row-ctl"><input id="dictation-key" class="d-input" type="password" autocomplete="off" spellcheck="false" aria-label="语音转文字密钥" /></span></label>
      <div class="row"><span class="row-main"><span id="dictation-test-note" class="row-desc"></span></span><span class="row-ctl"><button id="dictation-test" type="button" class="btn">测试连接</button><button id="dictation-save" type="button" class="btn btn-primary">保存</button></span></div>
    </div>
    <p id="dictation-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>`;

export async function mountDictationSettings(): Promise<void> {
  const provider = document.querySelector<HTMLSelectElement>("#dictation-provider")!;
  const source = document.querySelector<HTMLSelectElement>("#dictation-key-source")!;
  const key = document.querySelector<HTMLInputElement>("#dictation-key")!;
  const test = document.querySelector<HTMLButtonElement>("#dictation-test")!;
  const save = document.querySelector<HTMLButtonElement>("#dictation-save")!;
  const status = document.getElementById("dictation-status")!;
  let selected: DictationProvider = "chrome";
  let revision = 0;
  let conflict = false;
  let saving = false;
  let request: AbortController | undefined;
  const drafts = new Map<DictationProvider, string>();
  const report = (text: string, tone = "") => { status.textContent = text; status.dataset.tone = tone; };
  const cancel = () => { request?.abort(); request = undefined; test.disabled = false; revision += 1; };
  const render = () => {
    document.getElementById("dictation-description")!.textContent = DICTATION_PROVIDERS[selected].description;
    document.getElementById("dictation-source-row")!.hidden = selected !== "stepfun-realtime";
    document.getElementById("dictation-key-row")!.hidden = selected === "chrome" || selected === "stepfun-realtime" && source.value === "voice";
    document.getElementById("dictation-key-label")!.textContent = selected === "stepfun" ? "Step Plan 密钥" : selected === "stepfun-realtime" ? "Realtime 3 密钥（按量）" : "硅基流动 API 密钥";
    document.getElementById("dictation-test-note")!.textContent = selected === "chrome" ? "检查浏览器支持和麦克风权限；识别服务需实际说话验证。" : selected === "stepfun-realtime" ? "测试只检查连接与听写配置，不录音、不请求回答。按服务商规则计费。" : "测试会发送一小段静音，不录制麦克风；可能消耗少量额度。";
  };
  const loadKey = async () => {
    const mine = revision;
    const value: unknown = (await chrome.storage.local.get(`${DICTATION_KEY_PREFIX}${selected}`))[`${DICTATION_KEY_PREFIX}${selected}`];
    if (mine !== revision) return;
    key.value = drafts.get(selected) ?? (typeof value === "string" ? value : "");
  };
  provider.addEventListener("change", () => {
    if (!isDictationProvider(provider.value)) return;
    drafts.set(selected, key.value);
    cancel(); selected = provider.value; key.value = ""; report("尚未保存"); render(); void loadKey();
  });
  source.addEventListener("change", () => { cancel(); render(); report("尚未保存"); });
  key.addEventListener("input", () => { cancel(); drafts.set(selected, key.value); report("尚未保存"); });
  test.addEventListener("click", async () => {
    cancel();
    const mine = revision;
    const controller = new AbortController(); request = controller;
    test.disabled = true; report("正在测试连接…");
    try {
      if (selected === "chrome") {
        if (!("SpeechRecognition" in window) && !("webkitSpeechRecognition" in window)) throw new Error("当前浏览器不支持 Chrome 语音识别，请选择其他服务。");
        const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (permission.state !== "granted") {
          await chrome.tabs.create({ url: chrome.runtime.getURL("voice-permission.html") });
          throw new Error("请在打开的页面允许麦克风，然后再次测试。");
        }
        if (mine === revision) report("浏览器支持，麦克风已授权。请用左侧麦克风说一句话验证识别。", "ok");
      } else if (selected === "stepfun-realtime") {
        const credential = source.value === "voice" ? (await readVoiceDictationKey()).key : key.value;
        if (!credential.trim() && source.value === "voice") throw new Error("请先配置语音对话密钥，或改为单独填写密钥。");
        const connection = await openRealtimeDictation(credential, controller.signal, () => {}, () => {});
        connection.cancel();
        if (mine === revision) report("Realtime 3 听写连接成功。请保存后用左侧麦克风试说一句。", "ok");
      } else {
        await transcribeDictation(selected, key.value, dictationWav([new ArrayBuffer(48_000)]), controller.signal);
        if (mine === revision) report("连接成功。请保存后用左侧麦克风试说一句。", "ok");
      }
    } catch (error) {
      if (mine === revision) report(error instanceof Error ? error.message : "连接失败，请重试。", "err");
    } finally { if (mine === revision) { test.disabled = false; request = undefined; } }
  });
  save.addEventListener("click", async () => {
    cancel();
    if (conflict) { report("其他窗口修改了语音转文字设置，请重新打开此页后再保存。", "err"); return; }
    saving = true; save.disabled = true;
    try {
      const values: Record<string, unknown> = { [DICTATION_CONFIG_KEY]: { provider: selected, keySource: source.value === "voice" ? "voice" : "own" } };
      if (selected !== "chrome" && !(selected === "stepfun-realtime" && source.value === "voice")) values[`${DICTATION_KEY_PREFIX}${selected}`] = key.value.trim();
      await chrome.storage.local.set(values);
      report(selected !== "chrome" && !(selected === "stepfun-realtime" && source.value === "voice") && !key.value.trim() ? "已保存并清除密钥。填写密钥后才能使用此服务。" : "已保存，下次点击左侧麦克风时生效。", "ok");
    } catch { report("保存失败，请重试。", "err"); }
    finally { save.disabled = false; saving = false; }
  });
  const updateSourceNote = async () => {
    document.getElementById("dictation-key-source-note")!.textContent = (await readVoiceDictationKey()).description;
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ("inproc_voice_key" in changes || "inproc_cred:stepfun" in changes)) { cancel(); void updateSourceNote(); }
    if (area !== "local" || saving || !Object.keys(changes).some(name => name === DICTATION_CONFIG_KEY || name.startsWith(DICTATION_KEY_PREFIX))) return;
    cancel(); conflict = true;
    report("其他窗口修改了语音转文字设置，请重新打开此页查看。", "err");
  });
  addEventListener("pagehide", cancel);
  const initial = await readDictationSettings();
  if (revision === 0) { selected = initial.provider; provider.value = selected; source.value = initial.keySource; await loadKey(); render(); }
  await updateSourceNote();
}
