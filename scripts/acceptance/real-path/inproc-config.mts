import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, until, type JsonRecord, type launchRealPath } from "./harness.mts";

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

export interface ModelPlan {
  providerId: string;
  modelId: string;
  credential: JsonRecord;
  baseUrl?: string;
}

export const DEFAULT_TEST_MODEL = "openai-codex/gpt-6-luna";

export async function loadModelPlan(modelArg: string): Promise<ModelPlan> {
  const [providerId = "", ...idParts] = modelArg.split("/");

  if (providerId === "custom") {
    const baseUrl = process.env.SIDEAGENT_CUSTOM_BASE_URL;
    const key = process.env.SIDEAGENT_CUSTOM_KEY;

    if (!baseUrl || !key) throw new Error("custom/<模型> 需要环境变量 SIDEAGENT_CUSTOM_BASE_URL 与 SIDEAGENT_CUSTOM_KEY");

    return { providerId, modelId: idParts.join("/"), credential: { type: "api_key", key }, baseUrl };
  }

  const plans = JSON.parse(await readFile(join(homedir(), ".sideagent/providers.local.json"), "utf8")) as Record<string, { key?: string; source?: string }>;
  const plan = providerId === "stepfun" && !plans.stepfun ? { key: (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim() } : providerId === "openai-codex" ? plans[providerId] ?? { source: "pi-auth" } : plans[providerId];

  if (plan?.key) return { providerId, modelId: idParts.join("/"), credential: { type: "api_key", key: plan.key } };

  if (providerId === "kimi-coding") {
    const { renewKimi } = await import("../../maintenance/kimi-login.mjs");
    const kimi = await renewKimi(10 * 60_000);

    if (!kimi) throw new Error("Pi 里没有 Kimi 登录：先运行 npm run kimi:login");

    return { providerId, modelId: idParts.join("/"), credential: { type: "oauth", access: kimi.access, refresh: "", expires: kimi.expires } };
  }

  const login = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { type?: string; key?: string; access: string; refresh: string; expires: number; accountId?: string } | undefined>)[providerId];

  if (!plan && login?.type === "api_key" && login.key) return { providerId, modelId: idParts.join("/"), credential: { type: "api_key", key: login.key } };

  if (!plan) throw new Error(`providers.local.json 和 Pi 里都没有 ${providerId}`);

  if (!login || login.expires - Date.now() < (providerId === "openai-codex" ? 3 * 3_600_000 : 5 * 60_000)) throw new Error(`${providerId} 的登录令牌快过期了：先在 Pi 里用一次让它刷新`);

  const credential: JsonRecord = { type: "oauth", access: login.access, refresh: login.refresh, expires: login.expires };

  if (login.accountId) credential.accountId = login.accountId;

  return { providerId, modelId: idParts.join("/"), credential };
}

export function modelStorageItems(plan: ModelPlan): JsonRecord {
  const config: JsonRecord = { provider: plan.providerId, modelId: plan.modelId };

  if (plan.baseUrl) config.baseUrl = plan.baseUrl;

  return { inproc_model_config: config, [`inproc_cred:${plan.providerId}`]: plan.credential };
}

async function catalogBaseUrl(plan: ModelPlan): Promise<string> {
  const pi = join(REPO, "node_modules/@earendil-works/pi-ai/dist/providers/all.js");
  const { builtinModels } = await import(pi) as { builtinModels: () => { getModels(provider: string): Array<{ baseUrl: string; api: string }> } };
  const model = builtinModels().getModels(plan.providerId).find((m) => m.api === "openai-completions");

  if (!model) throw new Error(`${plan.providerId} 没有 OpenAI 兼容地址，不能当自定义服务配置`);

  return model.baseUrl;
}

export interface SettingsRun {
  testStatus: string;
  saveStatus: string;
  stored: JsonRecord;
  settingsTargetId: string;
  menuClicks: number;
  menuToggles: unknown;
}

export async function configureViaSettings(rp: RealPath, panel: string, plan: ModelPlan, { asCustom = false, asFast = false, baseUrl: customUrl }: { asCustom?: boolean; asFast?: boolean; baseUrl?: string } = {}): Promise<SettingsRun> {
  if (customUrl) asCustom = true;

  if (plan.credential.type !== "api_key") throw new Error("设置页路径只支持填 key 的套餐；订阅登录要真人在服务商网页上确认");
  const key = String(plan.credential.key);
  const baseUrl = customUrl ?? (asCustom ? await catalogBaseUrl(plan) : null);

  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#header-more")`)) || undefined, 15_000, "侧栏渲染");
  let menuClicks = 0;
  await rp.evaluate(panel, `window.__menuToggles = []; document.querySelector("#header-menu").addEventListener("toggle", (e) => __menuToggles.push([Math.round(performance.now()), e.newState])); true`);

  while (!(await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`))) {
    if (++menuClicks > 3) throw new Error("点了 3 次「更多」，菜单都没有打开");
    await rp.click(panel, "#header-more");
    await until(async () => (await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`)) || undefined, 2_000, "更多菜单展开").catch(() => undefined);
  }

  await rp.click(panel, "#model-settings-open");
  const menuToggles = await rp.evaluate(panel, "window.__menuToggles");
  const target = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.split("#")[0]!.endsWith("/settings.html")), 10_000, "设置页打开");
  const page = await rp.attach(target.targetId);
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");

  await rp.click(page, '[data-settings-page="models"]');
  await until(async () => (await rp.evaluate(page, `!!document.querySelector('#provider-more')`)) || undefined, 5_000, "模型页渲染");
  const add = await rp.evaluate(page, `document.querySelector('#provider-more').hidden`);
  if (add) await rp.click(page, '#connection-add');

  const directSelector = `.provider-option[data-provider="${asCustom ? "custom" : plan.providerId}"]`;
  const directVisible = await rp.evaluate(page, `!!document.querySelector('#provider-connected ${directSelector}')`);
  if (asCustom || !directVisible) await rp.evaluate(page, `(() => { const more = document.querySelector("#provider-more"); if (more) more.open = true; return true; })()`);
  if (asCustom || (await rp.evaluate(page, `!!document.querySelector(${JSON.stringify(directSelector)})`))) {
    await rp.click(page, directSelector);
  } else {
    await rp.evaluate(page, `(() => { const s = document.querySelector("#provider-search"); s.value = ${JSON.stringify(plan.providerId)}; s.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length === 1`)) || undefined, 5_000, `搜索出 ${plan.providerId}`);
    await rp.click(page, `.provider-option`);
    await rp.click(page, `button[data-region="${plan.providerId}"]`).catch(() => undefined);
  }
  await until(async () => (await rp.evaluate(page, `!document.querySelector("#provider-form").hidden`)) || undefined, 5_000, "服务商表单展开");

  if (baseUrl) {
    await rp.evaluate(page, `document.querySelector("#base-url").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#base-url");
    await rp.typeText(page, baseUrl);
  }

  await rp.evaluate(page, `document.querySelector("#api-key").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#api-key");
  await rp.typeText(page, key);
  await rp.evaluate(page, `document.querySelector("#model-id").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#model-id");
  await rp.evaluate(page, `document.querySelector("#model-id").select()`);
  await rp.typeText(page, plan.modelId);

  await rp.evaluate(page, `document.querySelector("#model-test").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#model-test");

  const testStatus = await until(async () => {
    const [tone, text] = await rp.evaluate(page, `[document.querySelector("#model-status").dataset.tone, document.querySelector("#model-status").textContent]`) as [string, string];

    const keyReason = await rp.evaluate(page, `document.querySelector('#key-reason').checkVisibility() ? document.querySelector('#key-reason-text').textContent : ''`);
    if (keyReason) throw new Error(`设置页试连失败：${keyReason}`);
    return tone === "ok" || tone === "err" ? text : undefined;
  }, 45_000, "测试连接出结果", 300);

  const saveButton = "#model-save";
  await rp.evaluate(page, `document.querySelector(${JSON.stringify(saveButton)}).scrollIntoView({ block: "center" }); true`);
  await rp.click(page, saveButton);

  const saveStatus = await until(async () => {
    const text = await rp.evaluate(page, `document.querySelector("#model-status").textContent`) as string;

    return text.startsWith("已保存") ? text : undefined;
  }, 10_000, "保存完成", 200);

  await useSavedSettingsModel(rp, page, asCustom ? 'custom' : plan.providerId, plan.modelId, asFast);
  const storageKey = asFast ? "inproc_fast_model_config" : "inproc_model_config";
  await until(async () => await rp.evaluate(page, `chrome.storage.local.get("${storageKey}").then(s => s["${storageKey}"]?.modelId === ${JSON.stringify(plan.modelId)})`) || undefined, 5000, '用途选择已保存');
  const stored = await rp.evaluate(page, `chrome.storage.local.get("${storageKey}").then((s) => s["${storageKey}"])`) as JsonRecord;

  return { testStatus, saveStatus, stored, settingsTargetId: target.targetId, menuClicks, menuToggles };
}

export async function useSavedSettingsModel(rp: RealPath, page: string, provider: string, modelId: string, asFast = false): Promise<void> {
  await rp.click(page, '#model-fast');
  const selectId = asFast ? 'fast-model' : 'main-model';
  await rp.click(page, `#${selectId}-picker`);
  await rp.evaluate(page, `(() => {
    const choice = [...document.querySelectorAll('#${selectId}-options .model-picker-option')].find(o => {
      try { const c = JSON.parse(o.dataset.value); return c.provider === ${JSON.stringify(provider)} && c.modelId === ${JSON.stringify(modelId)}; } catch { return false; }
    });
    if (!choice) throw new Error('模型选择器没有刚保存的模型');
    choice.dataset.acceptanceChoice = 'true';
  })()`);
  await rp.click(page, `#${selectId}-options [data-acceptance-choice]`);
  const key = asFast ? 'inproc_fast_model_config' : 'inproc_model_config';
  await until(async () => await rp.evaluate(page, `chrome.storage.local.get('${key}').then(s=>s['${key}']?.modelId === ${JSON.stringify(modelId)} && s['${key}']?.provider === ${JSON.stringify(provider)})`) || undefined, 5000, '模型用途保存');
}
