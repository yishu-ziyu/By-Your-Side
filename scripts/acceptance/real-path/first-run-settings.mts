/** 首次进入真实设置页：能开始连接，服务商图标完整，主模型与语音密钥状态跟随存储。
 * npx tsx scripts/acceptance/real-path/first-run-settings.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from './harness.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-first-run-settings`);
await mkdir(out, { recursive: true });
const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};
try {
  const { targetId } = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const page = await rp.attach(targetId);
  await until(async () => await rp.evaluate(page, `document.querySelector('#main-pick')?.checkVisibility()`) || undefined, 15000, '首次出现连接入口');
  await rp.screenshot(page, join(out, '1-first-screen.png'));
  assert.equal(await rp.evaluate(page, `document.querySelector('#main-model-picker').checkVisibility()`), false);
  assert.equal(await rp.evaluate(page, `document.querySelector('[data-settings-panel="models"] .connections-section').checkVisibility()`), true, '首次打开直接看到连接服务商');
  const first = await rp.evaluate(page, `(() => {
    const row=document.querySelector('.provider-option[data-provider="stepfun"]')?.getBoundingClientRect();
    return {open:document.querySelector('#provider-more').open, stepfunVisible:!!row && row.top>=0 && row.bottom<=innerHeight,
      letters:[...document.querySelectorAll('.plist .pv-letter')].map(e=>e.closest('.provider-option').dataset.provider).sort(),
      typesafe:!!document.querySelector('[data-provider="typesafe"]'), label:document.querySelector('#provider-more-names').textContent};
  })()`);
  evidence.first = first;
  assert.ok(first.open && first.stepfunVisible, '首次连接页能看到阶跃星辰');
  assert.ok(!first.typesafe, '不出现已退役的 TypeSafe');
  assert.deepEqual(first.letters, ['commandcode'], '没有品牌图标的 Command Code 使用首字，其余用品牌图标');
  assert.match(first.label, /选择服务商/);
  await rp.screenshot(page, join(out, '2-providers.png'));
  await rp.evaluate(page, `chrome.storage.local.set({inproc_model_config:{provider:'stepfun',modelId:'step-3.7-flash'},'inproc_cred:stepfun':{type:'api_key',key:'fixture-stepfun-key'}})`);
  await until(async () => await rp.evaluate(page, `document.querySelector('#provider-connected').textContent.includes('已添加 · 1')`) || undefined, 5000, '连接状态同步');
  await rp.click(page, '[data-settings-page="models"]');
  await until(async () => await rp.evaluate(page, `document.querySelector('#main-model-picker').textContent.includes('step-3.7-flash')`) || undefined, 5000, '主模型同步');
  assert.equal(await rp.evaluate(page, `document.querySelector('#main-pick').checkVisibility()`), false);
  await rp.click(page, '[data-settings-page="voice"]');
  const note = await rp.evaluate(page, `document.querySelector('#voice-key-note').textContent + document.querySelector('#voice-model-state').textContent`);
  assert.match(note, /阶跃星辰模型的密钥/);
  assert.doesNotMatch(note, /要先有阶跃星辰密钥/);
  await rp.screenshot(page, join(out, '3-stepfun-voice.png'));
  evidence.voiceNote = note;
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); }
finally { await writeFile(join(out, 'summary.json'), JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2)); await rp.close(); await rp.remove(); }
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));
if(error)process.exitCode=1;
