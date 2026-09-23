/**
 * 扩展内 agent 的模型配置：从本机套餐清单取凭据，两种方式交给扩展。
 *
 * - 快速路径：直接写扩展存储（与设置页写入的格式相同）。
 * - 设置页路径：像用户一样从侧栏「更多 → 模型与语音」打开设置页，点选服务商、输入 key 和模型、测试连接、保存。
 *
 * 套餐清单在 ~/.sideagent/providers.local.json。Kimi 是订阅登录，只借用 Pi 里当前有效的令牌，不在测试里刷新，
 * 避免和 Pi CLI 抢令牌轮换；设备码登录要真人在 Kimi 网页上确认，设置页路径不支持它。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, until, type JsonRecord, type launchRealPath } from "./harness.mts";

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

export interface ModelPlan {
  /** 套餐清单里的服务商。 */
  providerId: string;
  modelId: string;
  credential: JsonRecord;
}

export async function loadModelPlan(modelArg: string): Promise<ModelPlan> {
  const [providerId = "", ...idParts] = modelArg.split("/");
  // SAFETY: 本机套餐清单由用户维护，形状见文件头注释。
  const plans = JSON.parse(await readFile(join(homedir(), ".sideagent/providers.local.json"), "utf8")) as Record<string, { key?: string; source?: string }>;
  // 阶跃星辰的 key 就是语音用的那个，不在套餐清单里重复存一份。
  const plan = providerId === "stepfun" && !plans.stepfun ? { key: (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim() } : plans[providerId];

  if (!plan) throw new Error(`providers.local.json 里没有 ${providerId}`);

  if (plan.key) return { providerId, modelId: idParts.join("/"), credential: { type: "api_key", key: plan.key } };

  // SAFETY: Pi 的 auth.json 按服务商存 { access, refresh, expires }。
  const login = (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { access: string; refresh: string; expires: number } | undefined>)[providerId];

  if (!login || login.expires - Date.now() < 5 * 60_000) throw new Error(`${providerId} 的登录令牌快过期了：先在 Pi 里用一次让它刷新`);

  return { providerId, modelId: idParts.join("/"), credential: { type: "oauth", access: login.access, refresh: login.refresh, expires: login.expires } };
}

/** 快速路径要写进扩展存储的内容。 */
export function modelStorageItems(plan: ModelPlan): JsonRecord {
  return { inproc_model_config: { provider: plan.providerId, modelId: plan.modelId }, [`inproc_cred:${plan.providerId}`]: plan.credential };
}

/** 服务商在 pi-ai 目录里的地址，用来把同一个服务当成「自定义地址」配置。 */
async function catalogBaseUrl(plan: ModelPlan): Promise<string> {
  const pi = join(REPO, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js");
  // SAFETY: pi-ai 的公开入口，builtinModels 返回服务商目录。
  const { builtinModels } = await import(pi) as { builtinModels: () => { getModels(provider: string): Array<{ baseUrl: string; api: string }> } };
  const model = builtinModels().getModels(plan.providerId).find((m) => m.api === "openai-completions");

  if (!model) throw new Error(`${plan.providerId} 没有 OpenAI 兼容地址，不能当自定义服务配置`);

  return model.baseUrl;
}

export interface SettingsRun {
  /** 设置页显示的测试结果。 */
  testStatus: string;
  saveStatus: string;
  /** 保存后扩展存储里的模型选择（不含密钥）。 */
  stored: JsonRecord;
  settingsTargetId: string;
  menuClicks: number;
  /** 「更多」菜单每次开关的时间与状态，用来查第一下没打开的原因。 */
  menuToggles: unknown;
}

/**
 * 从侧栏菜单打开设置页，用真实点击和输入完成配置。asCustom 时把该服务当成「自定义地址」填写。
 * 返回设置页上看到的测试与保存结果；任何一步卡住都会抛错。
 */
export async function configureViaSettings(rp: RealPath, panel: string, plan: ModelPlan, { asCustom = false } = {}): Promise<SettingsRun> {
  if (plan.credential.type !== "api_key") throw new Error("设置页路径只支持填 key 的套餐；订阅登录要真人在服务商网页上确认");
  const key = String(plan.credential.key);
  const baseUrl = asCustom ? await catalogBaseUrl(plan) : null;

  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#header-more")`)) || undefined, 15_000, "侧栏渲染");
  // 侧栏刚渲染时第一下偶尔没打开菜单（未复现出原因）：像用户一样再点一次，次数记进结果。
  let menuClicks = 0;
  await rp.evaluate(panel, `window.__menuToggles = []; document.querySelector("#header-menu").addEventListener("toggle", (e) => __menuToggles.push([Math.round(performance.now()), e.newState])); true`);

  while (!(await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`))) {
    if (++menuClicks > 3) throw new Error("点了 3 次「更多」，菜单都没有打开");
    await rp.click(panel, "#header-more");
    await until(async () => (await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`)) || undefined, 2_000, "更多菜单展开").catch(() => undefined);
  }

  await rp.click(panel, "#model-settings-open");
  const menuToggles = await rp.evaluate(panel, "window.__menuToggles");
  const target = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  const page = await rp.attach(target.targetId);
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");

  await rp.click(page, `.provider-option[data-provider="${asCustom ? "custom" : plan.providerId}"]`);
  await until(async () => (await rp.evaluate(page, `!document.querySelector("#provider-form").hidden`)) || undefined, 5_000, "服务商表单展开");

  if (baseUrl) {
    await rp.click(page, "#base-url");
    await rp.typeText(page, baseUrl);
  }

  await rp.click(page, "#api-key");
  await rp.typeText(page, key);
  // 模型框预填了默认模型：全选后覆盖成要测的那个。
  await rp.click(page, "#model-id");
  await rp.evaluate(page, `document.querySelector("#model-id").select()`);
  await rp.typeText(page, plan.modelId);

  await rp.click(page, "#model-test");

  const testStatus = await until(async () => {
    // SAFETY: 这段页面脚本返回 [data-tone, textContent] 两个字符串。
    const [tone, text] = await rp.evaluate(page, `[document.querySelector("#model-status").dataset.tone, document.querySelector("#model-status").textContent]`) as [string, string];

    return tone === "ok" || tone === "err" ? text : undefined;
  }, 45_000, "测试连接出结果", 300);

  await rp.click(page, "#model-save");

  const saveStatus = await until(async () => {
    // SAFETY: textContent 是字符串。
    const text = await rp.evaluate(page, `document.querySelector("#model-status").textContent`) as string;

    return text.startsWith("已保存") ? text : undefined;
  }, 10_000, "保存完成", 200);

  // SAFETY: 这个键由设置页 save() 写入 InprocModelConfig 对象。
  const stored = await rp.evaluate(page, `chrome.storage.local.get("inproc_model_config").then((s) => s.inproc_model_config)`) as JsonRecord;

  return { testStatus, saveStatus, stored, settingsTargetId: target.targetId, menuClicks, menuToggles };
}
