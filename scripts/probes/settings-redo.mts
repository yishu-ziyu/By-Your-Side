/** 设置页「模型与语音」重做（#62）：真扩展、假凭据（不发网络请求），截图各状态并检查换模型、地区、保存几条路径。 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, until, sleep, REPO } from '../acceptance/real-path/harness.mts';

requireHeadless();

const shots = join(REPO, 'tmp', 'settings-redo');

await mkdir(shots, { recursive: true });

const results: string[] = [];

type Evidence = string | number | boolean | null | undefined | readonly Evidence[] | { readonly [key: string]: Evidence };

const check = (name: string, ok: boolean, note: Evidence = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(note)}`);

// 照用户 10-06 截图摆：OpenAI Codex 使用中，另有 5 家已连接。
const seed = {
  inproc_model_config: { provider: 'openai-codex', modelId: 'gpt-6-luna' },
  'inproc_cred:openai-codex': { type: 'oauth', access: 'fake', refresh: 'fake', expires: Date.now() + 864e5 },
  'inproc_cred:kimi-coding': { type: 'oauth', access: 'fake', refresh: 'fake', expires: Date.now() + 864e5 },
  'inproc_cred:stepfun': { type: 'api_key', key: 'sk-step-fake-a1F3' },
  'inproc_cred:opencode-go': { type: 'api_key', key: 'sk-oc-fake-9xQ2' },
  'inproc_cred:zai-coding-cn': { type: 'api_key', key: 'zai-fake-7Lm0' },
  'inproc_cred:minimax-cn': { type: 'api_key', key: 'mmx-fake-c81D' },
};

const rp = await launchRealPath();

try {
  const { targetId } = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const page = await rp.attach(targetId);
  const ev = (js: string) => rp.evaluate(page, js);
  const size = (width: number, height: number) => rp.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, page);
  const shot = async (name: string) => { await sleep(350); await rp.screenshot(page, join(shots, `${name}.png`)); };

  const stored = (key: string) => ev(`chrome.storage.local.get(${JSON.stringify(key)}).then(s => s[${JSON.stringify(key)}] ?? null)`);

  await until(async () => await ev('!!document.querySelector("#provider-search")'), 15000, 'settings');
  await ev(`chrome.storage.local.set(${JSON.stringify(seed)}).then(() => true)`);
  await ev('location.reload(); true');
  await sleep(500);
  await until(async () => await ev('document.querySelectorAll(".provider-option").length > 3'), 15000, 'providers');
  await size(720, 1000);
  await shot('1-default');

  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const connected = await ev('[...document.querySelectorAll("#provider-connected .prow")].map(b => b.dataset.provider + ":" + (b.querySelector(".st")?.textContent ?? ""))') as string[];
  check('已连接 6 家在上，正在用的第一', connected.length === 6 && connected[0] === 'openai-codex:使用中', connected);
  check('MiniMax 两个地区合成一行，状态带地区', connected.some((c) => c === 'minimax-cn:已填 key · 中国'), connected);
  check('其余服务商默认折起', !(await ev('document.querySelector("#provider-more").open')));
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const icons = await ev('[...document.querySelectorAll(".prow .pv")].filter(e => !e.classList.contains("pv-letter") && !e.classList.contains("pv-glyph")).length') as number;
  check('有品牌图标的行用图标', icons >= 24, `${icons} 个`);

  // 主模型下拉：只列已连接的，直接换
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const mainGroups = await ev('[...document.querySelectorAll("#main-model optgroup")].map(g => g.label)') as string[];
  check('主模型下拉只列已连接的服务商', mainGroups.length === 6 && !mainGroups.includes('Anthropic'), mainGroups);
  await ev(`(() => { const s = document.querySelector("#main-model"); s.value = JSON.stringify({ provider: "zai-coding-cn", modelId: "glm-5.3-flash" }); s.dispatchEvent(new Event("change")); return true; })()`);
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  await until(async () => (await stored('inproc_model_config') as { provider?: string } | null)?.provider === 'zai-coding-cn' || undefined, 5000, 'main switch');
  await sleep(300);
  const afterSwitch = await ev('[document.querySelector("#main-status").textContent, document.querySelector("#provider-connected .prow")?.dataset.provider]');
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  check('换主模型一步写入存储，列表把新的一家排第一', JSON.stringify(afterSwitch).includes('智谱') && (afterSwitch as string[])[1] === 'zai-coding-cn', afterSwitch);
  await shot('2-main-switched');
  await ev(`(() => { const s = document.querySelector("#main-model"); s.value = JSON.stringify({ provider: "openai-codex", modelId: "gpt-6-luna" }); s.dispatchEvent(new Event("change")); return true; })()`);
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  await until(async () => (await stored('inproc_model_config') as { provider?: string } | null)?.provider === 'openai-codex' || undefined, 5000, 'main back');

  // 搜索同时匹配模型名
  await rp.click(page, '#provider-search');
  await rp.typeText(page, 'glm');
  await sleep(200);
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const hits = await ev('[...document.querySelectorAll(".prow")].map(b => b.querySelector(".p-name").textContent)') as string[];
  check('搜 glm 命中模型名所在的服务商', hits.some((h) => h.includes('OpenRouter')) && !hits.some((h) => h.startsWith('Anthropic')), hits.length);
  await rp.click(page, '.provider-option[data-provider="zai-coding-cn"]');
  await shot('3-search-glm-open');
  const zhipu = await ev('({ saved: document.querySelector("#key-saved").hidden, tail: document.querySelector("#key-tail").textContent, keyRow: document.querySelector("#key-row").hidden, model: document.querySelector("#model-id").value })');
  check('已存 key 只显示末四位，不露输入框', JSON.stringify(zhipu) === JSON.stringify({ saved: false, tail: ' · 末四位 7Lm0', keyRow: true, model: 'glm-5.3-flash' }), zhipu);
  await ev('(() => { const s = document.querySelector("#provider-search"); s.value = ""; s.dispatchEvent(new Event("input")); return true; })()');

  // 地区：MiniMax 打开已连接的「中国」，切到「国际」
  await rp.click(page, '.provider-option[data-provider="minimax-cn"]');
  const region = await ev('[...document.querySelectorAll("#region-row button")].map(b => b.textContent + ":" + b.getAttribute("aria-checked"))');
  check('MiniMax 打开已连接的地区', JSON.stringify(region) === JSON.stringify(['国际:false', '中国:true']), region);
  await rp.click(page, '#region-row [data-region="minimax"]');
  const intl = await ev('({ key: document.querySelector("#key-row").hidden, label: document.querySelector("#key-label").textContent })');
  check('切到国际：这一区没存 key，露出输入框', JSON.stringify(intl) === JSON.stringify({ key: false, label: 'API key' }), intl);
  await rp.click(page, '#region-row [data-region="minimax-cn"]');
  await shot('4-minimax-region');

  // 账号登录：Kimi 的按钮文案是中文
  await rp.click(page, '.provider-option[data-provider="kimi-coding"]');
  const kimi = await ev('({ state: document.querySelector("#oauth-state").textContent, login: document.querySelector("#oauth-login").textContent, logout: !document.querySelector("#oauth-logout").hidden, key: document.querySelector("#key-row").hidden })');
  check('已登录：一行状态 + 重新登录 / 退出', JSON.stringify(kimi) === JSON.stringify({ state: '已登录，令牌会自动续期。', login: '重新登录', logout: true, key: true }), kimi);
  await ev('document.querySelector("#provider-more").open = true; true');
  await ev('document.querySelector(\'.provider-option[data-provider="xai"]\').scrollIntoView({ block: "center" }); true');
  await rp.click(page, '.provider-option[data-provider="xai"]');
  const xai = await ev('document.querySelector("#oauth-login").textContent');
  check('xAI 登录按钮译成中文', xai === '用 SuperGrok 或 X Premium 登录', xai);
  await shot('5-xai-login');

  // 模型下拉：点开有目录，能筛选，能填目录外的名字
  await rp.click(page, '#model-id');
  await sleep(150);
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const listed = await ev('document.querySelectorAll("#model-options .combo-opt").length') as number;
  await shot('6-model-combo');
  await ev('(() => { const i = document.querySelector("#model-id"); i.value = ""; return true; })()');
  await rp.typeText(page, 'grok-4.6');
  await sleep(150);
  const filtered = await ev('[...document.querySelectorAll("#model-options .combo-opt")].map(o => o.dataset.id)');
  check('模型下拉列目录并能筛选', listed >= 3 && JSON.stringify(filtered) === '["grok-4.6"]', { listed, filtered });
  await ev('(() => { const i = document.querySelector("#model-id"); i.value = ""; return true; })()');
  await rp.typeText(page, 'my-own-model');
  await sleep(150);
  const note = await ev('document.querySelector("#model-options .combo-note").textContent');
  check('目录外的名字可以填', String(note).includes('保存时按你填的名称调用'), note);
  await ev('document.activeElement.blur(); true');

  // 自定义地址：照旧能保存（与 real-path 验收同一组选择器）
  await ev('document.querySelector(\'.provider-option[data-provider="custom"]\').scrollIntoView({ block: "center" }); true');
  await rp.click(page, '.provider-option[data-provider="custom"]');

  for (const [sel, value] of [['#base-url', 'http://127.0.0.1:9/v1'], ['#api-key', 'x'], ['#model-id', 'fixture']]) {
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); e.focus(); e.select?.(); return true; })()`);
    await rp.typeText(page, value);
  }

  await ev('document.activeElement.blur(); document.querySelector("#model-save").scrollIntoView({ block: "center" }); true');
  await rp.click(page, '#model-save');
  await until(async () => String(await ev('document.querySelector("#model-status").textContent')).startsWith('已保存') || undefined, 5000, 'custom saved');
  const custom = await stored('inproc_model_config');
  // SAFETY: 这个键只由设置页写入，值就是模型配置。
  const c = custom as { provider?: string; modelId?: string; baseUrl?: string } | null;
  check('自定义地址保存并使用', c?.provider === 'custom' && c.modelId === 'fixture' && c.baseUrl === 'http://127.0.0.1:9/v1', custom);
  await shot('7-custom-saved');

  // 下半页与整页
  await size(720, 3300);
  await ev('scrollTo(0, 0); document.querySelector(".prow[aria-expanded=true]")?.click(); true');
  await shot('8-fullpage');
  const switches = await ev('[...document.querySelectorAll(".sw")].map(s => s.id)');
  check('下半页四个开关都在', JSON.stringify(switches) === JSON.stringify(['selection-bar', 'link-preview', 'nudge', 'open-threads']), switches);
  await rp.click(page, '.timbre-option[data-voice]:not([aria-checked="true"])');
  await sleep(300);
  // SAFETY: 页面脚本按这段表达式返回这个形状。
  const voice = await ev('chrome.storage.local.get("step_voice").then(s => [document.querySelector(\'.timbre-option[aria-checked="true"]\').dataset.voice, s.step_voice])') as string[];
  check('点音色就保存', voice[0] === voice[1] && !!voice[0], voice);

  // 深色与窄窗口
  await rp.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, page);
  await shot('9-dark-fullpage');
  await rp.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, page);
  await size(420, 1600);
  await shot('10-narrow');
  const overflow = await ev('document.documentElement.scrollWidth > innerWidth');
  check('窄窗口没有横向滚动', overflow === false, overflow);
} finally {
  await rp.close();
}

console.log(results.join('\n'));

console.log(`截图：${shots}`);
