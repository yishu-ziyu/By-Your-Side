/** 设置页连 Command Code：模型下拉列出它公开清单里的全部模型，Claude 和其他家的都在，用户自己挑。
 * 需要能连上 api.commandcode.ai（清单接口不要 key）。
 * npx tsx scripts/acceptance/real-path/commandcode-model-list.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from './harness.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-commandcode-model-list`);
await mkdir(out, { recursive: true });
const published = await fetch('https://api.commandcode.ai/provider/v1/models').then(r => r.json()) as { data: Array<{ id: string }> };
const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = { published: published.data.length };
try {
  const { targetId } = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const page = await rp.attach(targetId);
  await until(async () => await rp.evaluate(page, `!!globalThis.chrome?.storage && document.readyState === 'complete'`) || undefined, 15000, '设置页加载');
  await rp.evaluate(page, `chrome.storage.local.set({inproc_model_config:{provider:'commandcode',modelId:'xiaomi/mimo-v2.6-flash'},'inproc_cred:commandcode':{type:'api_key',key:'fixture-commandcode-key'}})`);
  await rp.evaluate(page, `location.reload()`);
  await until(async () => await rp.evaluate(page, `!!document.querySelector('.provider-option[data-provider="commandcode"]')`) || undefined, 15000, '连接页出现 Command Code');
  await rp.evaluate(page, `document.querySelector('[data-settings-page="connections"]')?.click()`);
  await rp.click(page, '.provider-option[data-provider="commandcode"]');
  await until(async () => await rp.evaluate(page, `/列表里有 (\\d+) 个/.exec(document.querySelector('#model-meta').textContent)?.[1] > 2`) || undefined, 15000, '清单到达后模型数超过内置的 2 个');
  await rp.click(page, '#model-toggle');
  const shown = await rp.evaluate(page, `({meta:document.querySelector('#model-meta').textContent, options:[...document.querySelectorAll('#model-options [role=option]')].map(o=>o.textContent.trim())})`);
  evidence.meta = shown.meta;
  evidence.options = shown.options.length;
  await rp.screenshot(page, join(out, '1-commandcode-models.png'));
  assert.equal(shown.options.length, published.data.length, '下拉列出清单里的全部模型');
  for (const id of ['claude-opus-5-5', 'gpt-6-luna', 'deepseek/deepseek-v4-pro', 'xiaomi/mimo-v2.6-flash']) assert.ok(shown.options.some((o: string) => o.includes(id)), `列表里有 ${id}`);
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); }
finally { await writeFile(join(out, 'summary.json'), JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2)); await rp.close(); await rp.remove(); }
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));
if(error)process.exitCode=1;
