/** Real extension settings, using isolated storage and local scripted models only.
 * npx tsx scripts/acceptance/real-path/settings-panel.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-settings-panel`);
await mkdir(out, { recursive: true });
const good = await startScriptedModel([{ match: 'Reply with the single word OK.', steps: [{ text: 'OK' }] }]);
const bad = await startScriptedModel([{ match: 'Reply with the single word OK.', steps: [{ status: 401, body: '{"error":{"message":"Invalid API key"}}' }] }]);
const replacement = await startScriptedModel([{match:'Reply with the single word OK.',steps:[{text:'OK'}]},{match:'LOCAL_ENDPOINT_CHECK',steps:[{text:'连接地址已更新'}]}]);
const slow = await startScriptedModel([{ match: 'Reply with the single word OK.', steps: [{ text: 'OK', delayMs: 4000 }] }]);
const rp = await launchRealPath();
let error: string | null = null;
const checked: string[] = [];
let page = '';
const click = async (selector: string) => {
  await rp.evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
  assert.ok(await rp.evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`), `控件不可见：${selector}`);
  await rp.click(page, selector);
};
const text = (selector: string) => rp.evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
const fill = async (selector: string, value: string) => {
  await click(selector);
  await rp.evaluate(page, `document.querySelector(${JSON.stringify(selector)}).select()`);
  await rp.typeText(page, value);
};
const stored = (key: string, session = page) => rp.evaluate(session, `chrome.storage.local.get(${JSON.stringify(key)}).then(s=>s[${JSON.stringify(key)}] ?? null)`);
const nav = async (name: string) => {
  await click(`[data-settings-page="${name}"]`);
  assert.equal(await rp.evaluate(page, `document.querySelector('[data-settings-panel="${name}"]').hidden`), false);
};
const choose = async (role: string, provider: string, id: string) => {
  await click(`#${role}-model-picker`);
  const search = `#${role}-model-options input`;
  await fill(search, id);
  await rp.evaluate(page, `(() => { const b = [...document.querySelectorAll('#${role}-model-options .model-picker-option')].find(b => { try { const c=JSON.parse(b.dataset.value);return c.provider===${JSON.stringify(provider)} && c.modelId===${JSON.stringify(id)}; } catch {return false;} });if(!b)throw Error('搜索结果缺少模型');b.dataset.pick='target'; })()`);
  await click(`#${role}-model-options [data-pick="target"]`);
};
const openCustom = async () => {
  await nav('connections');
  if (await rp.evaluate(page, `document.querySelector('#provider-custom').children.length === 0`)) await click('#connection-add');
  await click('[data-provider="custom"]');
  assert.equal(await rp.evaluate(page, `document.querySelector('#connection-dialog').open`), true);
};
try {
  const { targetId } = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html` });
  page = await rp.attach(targetId);
  await until(async () => await rp.evaluate(page, `document.querySelector('#main-model') !== null`) || undefined, 15000, '设置页加载');
  await rp.screenshot(page, join(out, '01-first-use.png'));
  assert.equal(await rp.evaluate(page, `document.querySelectorAll('[data-settings-page]').length`), 6, '设置页应有六个独立入口');
  checked.push('六页导航与首次使用');
  if (!process.argv.includes('--navigation-only')) {
    await rp.evaluate(page, `chrome.storage.local.set({inproc_model_config:{provider:'stepfun',modelId:'step-3.7-flash'},'inproc_cred:stepfun':{type:'api_key',key:'acceptance-not-a-real-key'}})`);
    await until(async () => (await text('#main-model-picker')).includes('step-3.7-flash') || undefined, 5000, '主模型显示');
    await rp.screenshot(page, join(out, '02-models.png'));
    const secondTarget = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html#models`, newWindow: true, background: true });
    const second = await rp.attach(secondTarget.targetId);
    await until(async () => await rp.evaluate(second, `!!document.querySelector('#main-model-picker')`) || undefined, 15000, '第二个窗口加载');
    await openCustom();
    await fill('#base-url', good.baseUrl);
    await fill('#model-id', 'settings-local-model');
    await fill('#api-key', 'acceptance-local-only');
    await click('#model-save');
    await until(async () => (await text('#model-status')).startsWith('已保存连接') || undefined, 10000, '连接已保存');
    assert.equal((await stored('inproc_model_config')).provider, 'stepfun', '添加连接不能切换主模型');
    assert.equal((await stored('settings_connection:custom')).baseUrl, good.baseUrl.replace(/\/+$/, ''));
    await rp.screenshot(page, join(out, '03-connection-saved.png'));
    await click('#model-fast');
    await choose('main', 'custom', 'settings-local-model');
    await until(async () => (await stored('inproc_model_config'))?.provider === 'custom' || undefined, 5000, '主模型切换');
    await until(async () => (await rp.evaluate(second, `document.querySelector('#main-model-picker').textContent`)).includes('settings-local-model') || undefined, 5000, '第二窗口同步模型');
    await choose('main', 'stepfun', 'step-3.7-flash');
    await until(async () => (await stored('inproc_model_config'))?.provider === 'stepfun' || undefined, 5000, '切回主模型');
    await choose('backup', 'custom', 'settings-local-model');
    await until(async () => (await stored('inproc_backup_model_config'))?.baseUrl === good.baseUrl.replace(/\/+$/, '') || undefined, 5000, '自定义地址仍可作备用');
    checked.push('真实脚本服务连接、保存不切主模型、自定义地址再次选择、第二窗口同步');
    await openCustom();
    await fill('#base-url', bad.baseUrl);
    await click('#key-change');
    await fill('#api-key', 'acceptance-invalid');
    await click('#model-save');
    await until(async () => await rp.evaluate(page, `(document.querySelector('#key-reason').checkVisibility() && document.querySelector('#key-reason').textContent.includes('密钥')) || (document.querySelector('#model-status').checkVisibility() && document.querySelector('#model-status').textContent.includes('密钥'))`) || undefined, 10000, '错误理由显示');
    assert.equal((await stored('settings_connection:custom')).baseUrl, good.baseUrl.replace(/\/+$/, ''), '验证失败不能覆盖旧连接');
    await rp.screenshot(page, join(out, '04-connection-error.png'));
    await fill('#base-url', slow.baseUrl);
    await click('#model-save');
    await until(async () => (await text('#model-status')).includes('正在测试') || undefined, 3000, '慢请求开始');
    await click('#connection-close');
    await until(async () => await rp.evaluate(page, `!document.querySelector('#connection-dialog').open`) || undefined, 3000, '取消连接测试');
    assert.equal((await stored('settings_connection:custom')).baseUrl, good.baseUrl.replace(/\/+$/, ''));
    checked.push('错误原因与取消不保存');
    await openCustom();
    await click('#model-id');
    await rp.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, page);
    await rp.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, page);
    assert.equal(await rp.evaluate(page, `document.querySelector('#connection-dialog').open`), true, 'Esc 只关闭模型列表');
    await fill('#base-url', replacement.baseUrl);
    await click('#key-change');
    await fill('#api-key', 'acceptance-replacement-key');
    await click('#model-save');
    await until(async () => (await text('#model-status')).startsWith('已保存连接') || undefined, 10000, '替换自定义地址完成');
    const backup = await stored('inproc_backup_model_config');
    const credential = await stored('inproc_cred:custom');
    assert.equal(backup.baseUrl, replacement.baseUrl.replace(/\/+$/, ''));
    assert.equal(credential.env.SIDEAGENT_CUSTOM_ENDPOINT, backup.baseUrl, '密钥绑定新地址');
    assert.equal((await stored('inproc_model_config')).provider, 'stepfun', '其他服务商的用途保持');
    await click('#connection-close');
    assert.equal(await rp.evaluate(page, `document.activeElement?.dataset.provider`), 'custom', '关闭后焦点回到连接行');
    // An in-flight task may retain an old model object; its newly resolved key must still target the new endpoint.
    const oldRequests = good.requests.length;
    await rp.evaluate(page, `chrome.storage.local.set({inproc_model_config:{provider:'custom',modelId:'settings-local-model',baseUrl:${JSON.stringify(good.baseUrl)}}})`);
    const panel = await rp.attach(await rp.openSidePanel());
    await until(async () => await rp.evaluate(panel, `document.querySelector('#input') !== null`) || undefined, 15000, '侧栏准备好');
    await rp.click(panel, '#input'); await rp.typeText(panel, 'LOCAL_ENDPOINT_CHECK'); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.body.textContent.includes('连接地址已更新')`) || undefined, 20000, '真实任务使用新地址');
    assert.equal(good.requests.length, oldRequests, '旧地址没有收到新凭据的请求');
    await nav('models');
    await choose('main', 'stepfun', 'step-3.7-flash');
    checked.push('更新地址与密钥配对、旧模型对象仍发往新地址、Esc 与焦点返回');

    await nav('voice');
    await click('[data-model="stepaudio-2.5-realtime"]');
    await until(async () => await stored('inproc_voice_model') === 'stepaudio-2.5-realtime' || undefined, 5000, '语音模型保存');
    await click('[data-voice="qingchunshaonv"]');
    await until(async () => await stored('step_voice') === 'qingchunshaonv' || undefined, 5000, '音色保存');
    await rp.screenshot(page, join(out, '05-voice.png'));
    await click(`[data-model="gpt-live-1-codex"]`);
    await until(async () => await rp.evaluate(page, `document.querySelector('#voice-key-row').hidden && document.querySelectorAll('#timbre-list .timbre-option').length === 1`) || undefined, 5000, 'GPT-Live 下只剩它自己的声音、不显示阶跃星辰密钥');
    await rp.evaluate(page, `scrollTo(0, document.scrollingElement.scrollHeight)`);
    const pinned = await rp.evaluate(page, `({ y: scrollY, top: document.querySelector('.settings-sidebar').getBoundingClientRect().top })`) as { y: number; top: number };
    assert.ok(pinned.y > 0 && Math.abs(pinned.top) < 1, `滚到底时左栏仍贴在顶部：${JSON.stringify(pinned)}`);
    await rp.screenshot(page, join(out, '05b-voice-gpt-live.png'));
    checked.push('音色跟着语音模型变、左栏滚动时不动');
    await nav('appearance');
    await click('button[data-tone-option="warm"]');
    await until(async () => await stored('color_tone') === 'warm' || undefined, 5000, '暖纸底色保存');
    assert.equal(await rp.evaluate(page, 'document.documentElement.dataset.tone'), 'warm');
    await rp.screenshot(page, join(out, '06-appearance.png'));
    await nav('preferences');
    const before = await rp.evaluate(page, `document.querySelector('#selection-bar').checked`);
    await click('#selection-bar');
    await until(async () => await rp.evaluate(second, `document.querySelector('#selection-bar').checked === ${JSON.stringify(!before)}`) || undefined, 5000, '另一窗口同步偏好');
    await rp.cdp.send('Page.reload', {}, page);
    await until(async () => await rp.evaluate(page, `document.querySelector('#settings-nav button.active')?.dataset.settingsPage === 'preferences' && document.querySelector('#selection-bar').checked === ${JSON.stringify(!before)}`) || undefined, 15000, '重开后保留页面和偏好');
    await rp.screenshot(page, join(out, '07-preferences.png'));
    await nav('data');
    assert.ok((await text('[data-settings-panel="data"]')).includes('诊断记录'));
    await rp.screenshot(page, join(out, '08-data.png'));
    checked.push('语音、音色、底色、偏好重开和跨窗口同步、诊断入口');
    await nav('models');
    await rp.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, page);
    await rp.screenshot(page, join(out, '09-models-dark.png'));
    await rp.cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 1, mobile: false }, page);
    assert.ok(await rp.evaluate(page, `document.documentElement.scrollWidth <= innerWidth`), '窄屏不能横向溢出');
    await choose('fast', 'custom', 'settings-local-model');
    await rp.screenshot(page, join(out, '10-narrow.png'));
    checked.push('深色、减少动态效果、窄屏模型搜索');
  }
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); if (page) { await rp.screenshot(page, join(out, 'failure.png')).catch(() => {}); const visible = await rp.evaluate(page, `({page:location.hash,status:document.querySelector('#model-status')?.textContent,keyReason:document.querySelector('#key-reason')?.textContent})`).catch(()=>null); await writeFile(join(out,'failure-state.json'),JSON.stringify(visible,null,2)); } }
finally {
  await writeFile(join(out, 'summary.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, checked }, null, 2));
  await rp.close(); await rp.remove(); await good.close(); await bad.close(); await slow.close(); await replacement.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error, checked }));
if (error) process.exitCode = 1;
