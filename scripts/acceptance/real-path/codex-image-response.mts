import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
import { loadModelPlan } from './inproc-config.mts';

requireHeadless();
const live = process.argv.includes('--live');
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-codex-image-response`);
await mkdir(out, { recursive: true });
const answer = '截图里的核对码是 TERRA-482。';
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<title>图片响应验收</title><canvas id="scene" width="1100" height="750"></canvas><script>const c=scene.getContext("2d"),p=c.createImageData(1100,750);let n=482;for(let i=0;i<p.data.length;i+=4){n=(n*1664525+1013904223)>>>0;const shade=100+((n>>>24)%32);p.data[i]=shade;p.data[i+1]=shade+40;p.data[i+2]=shade+60;p.data[i+3]=255}c.putImageData(p,0,0);c.fillStyle="#b21";c.fillRect(30,30,600,130);c.fillStyle="white";c.font="bold 56px sans-serif";c.fillText("TERRA-482",60,115)</script>'));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const checker = await startScriptedModel([{ match: '"requests"', steps: [{ text: JSON.stringify({ scope: 'local' }) }] }, { match: '', steps: [{ text: JSON.stringify({ problems: [], status: 'done', summary: answer }) }] }]);
const rp = await launchRealPath();
const timers = new Set<ReturnType<typeof setTimeout>>();
const requests: Array<{ image: boolean; elapsed?: number; delivered?: boolean; mime?: string; chars?: number }> = [];
let panel = '', failure = '';
try {
  const helper = await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/voice-permission.html` });
  const h = await rp.attach(helper.targetId);
  await until(() => rp.evaluate(h, '!!globalThis.chrome?.storage?.local'), 20000, '扩展存储就绪');
  const plan = live ? await loadModelPlan('openai-codex/gpt-6.1-terra') : null;
  const accountId = String(plan?.credential.accountId ?? 'image-response-fixture');
  const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64')}.fixture`;
  const entry = { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high'], input: ['text', 'image'], contextWindow: 128000, discoveryOnly: false };
  const config = {
    'inproc_cred:openai-codex': plan?.credential ?? { type: 'oauth', access, refresh: '', expires: Date.now() + 3600000, accountId },
    inproc_codex_catalog: { identity: createHash('sha256').update(`openai-codex\0${accountId}`).digest('hex'), checkedAt: Date.now(), models: [entry], discoveryComplete: true },
    inproc_model_config: { provider: 'openai-codex', modelId: entry.id },
    inproc_fast_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: checker.baseUrl },
    'inproc_cred:custom': { type: 'api_key', key: 'fixture' },
  };
  await rp.evaluate(h, `chrome.storage.local.set(${JSON.stringify(config)}).then(()=>true)`);
  panel = await rp.attach(await rp.openSidePanel());
  const host = await until(async () => (await rp.targets()).find(t => t.url.endsWith('/inproc.html')), 30000, '后台模型宿主');
  const hostSession = await rp.attach(host.targetId);
  rp.cdp.onEvent('Fetch.requestPaused', (event: { sessionId?: string; params: { requestId: string; request: { postData?: string; method: string } } }) => {
    if (event.sessionId !== hostSession) return;
    const { requestId, request } = event.params;
    if (request.method !== 'POST') { void rp.cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: '' }, hostSession).catch(() => {}); return; }
    const payload = JSON.parse(request.postData ?? '{}');
    const image = JSON.stringify(payload.input).includes('input_image');
    const imagePart = payload.input?.flatMap((item: any) => Array.isArray(item.output) ? item.output : item.content ?? []).find((part: any) => part?.type === 'input_image');
    const record = { image, ...(imagePart ? { mime: imagePart.image_url.slice(5, imagePart.image_url.indexOf(';')), chars: imagePart.image_url.length } : {}) } as typeof requests[number]; requests.push(record);
    const started = Date.now();
    const item = image
      ? { type: 'message', id: 'msg-image', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }
      : { type: 'function_call', id: 'fc-image', call_id: 'call-image', name: 'screenshot', arguments: '{}' };
    const events = [
      { type: 'response.created', response: { id: 'resp-image' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp-image', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
    ];
    const timer = setTimeout(() => {
      timers.delete(timer); record.elapsed = Date.now() - started;
      void rp.cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')).toString('base64') }, hostSession).then(() => { record.delivered = true; }, () => { record.delivered = false; });
    }, image ? 18000 : 0);
    timers.add(timer);
  });
  if (!live) await rp.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*chatgpt.com/backend-api/codex/responses*', requestStage: 'Request' }] }, hostSession);
  else {
    rp.cdp.onEvent('Network.requestWillBeSent', (event: any) => {
      if (event.sessionId !== hostSession || event.params.request.method !== 'POST' || !event.params.request.url.includes('/codex/responses')) return;
      const payload = JSON.parse(event.params.request.postData ?? '{}');
      const parts = payload.input?.flatMap((item: any) => Array.isArray(item.output) ? item.output : item.content ?? []) ?? [];
      const image = parts.find((part: any) => part?.type === 'input_image');
      requests.push({ image: !!image, ...(image ? { mime: image.image_url.slice(5, image.image_url.indexOf(';')), chars: image.image_url.length } : {}) });
    });
    await rp.cdp.send('Network.enable', { maxPostDataSize: 32000000 }, hostSession);
  }
  await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${siteAddress(site).port}/`)},active:true})`);
  await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`), 60000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, live ? '拍一张截图，逐字读出红色框里的核对码。只输出核对码，使用半角短横线连接前后两段。' : '拍一张截图，读出红色框里的核对码。'); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp.evaluate(panel, `({answer:document.querySelector('#messages')?.innerText.includes(${JSON.stringify(live ? 'TERRA-482' : answer)}),error:document.querySelector('.error-card')?.textContent})`) as { answer: boolean; error?: string };
    if (state.error) throw Error(state.error);
    return state.answer;
  }, 55000, '图片响应无需手动重试直接显示');
  if (!live) assert.equal(requests.filter(r => !r.image).length, 1, '恢复不重拍截图');
  assert.ok(requests.some(r => r.image), '模型确实收到截图后读出画面中的码');
  assert.ok(requests.filter(r => r.image).every(r => r.mime === 'image/webp'), '大截图通过实际模型接口以紧凑图片发送');
  if (!live) assert.ok(requests.some(r => r.image && r.delivered && r.elapsed! >= 18000), '截图输入后真正接住晚到的响应');
  await rp.screenshot(panel, join(out, 'answer.png'));
} catch (error) {
  failure = String(error);
  if (panel) await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {});
} finally {
  for (const timer of timers) clearTimeout(timer);
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', live, failure, requests }, null, 2));
  await rp.close(); await rp.remove(); await checker.close(); site.close();
}
console.log(JSON.stringify({ out, failure, requests }));
if (failure) process.exitCode = 1;
