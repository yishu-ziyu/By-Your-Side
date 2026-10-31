/**
 * 重载含长记录的真实扩展：等待真正就绪，随后打开旧会话并发送，模型输入必须仍带着旧记录。
 * 本机脚本模型只用于核对恢复后的输入；不测远端模型速度。
 * --rounds=N 重复同一份存储的重载；--baseline 只采集旧版时间，不要求优化后的读量与档位行为。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const baseline = process.argv.includes('--baseline');
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.split('=')[1] ?? 3);
const count = Number(process.argv.find(arg => arg.startsWith('--conversations='))?.split('=')[1] ?? 16);
const bytes = Number(process.argv.find(arg => arg.startsWith('--record-kib='))?.split('=')[1] ?? 256) * 1024;
const remembered = '旧会话里的核对码是白鹭七号。';
const answer = '启动后仍记得白鹭七号。';
let restoredInput = false;
const model = await startScriptedModel([
  { match: '启动核对', steps: [{ text: answer }] },
  { match: remembered, steps: [{ text: '已收到核对码。' }] },
], undefined, payload => {
  if (payload.tools?.length && JSON.stringify(payload.messages).includes('启动核对')) restoredInput ||= JSON.stringify(payload.messages).includes(remembered);
});
const artifacts = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-startup-ready${baseline ? '-baseline' : ''}`);
await mkdir(artifacts, { recursive: true });
const rp = await launchRealPath();
const evidence: Record<string, unknown> = { baseline, count, bytes, rounds: [] };
let panel = '';
let failure: unknown;
async function attachPanel() {
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, `!!document.querySelector('#input')`), 20_000, '侧栏输入框');
}
async function timings() {
  const result: Record<string, unknown> = {};
  for (const target of await rp.targets()) {
    if (!target.url.startsWith(`chrome-extension://${rp.extensionId}/`) || !/\/(inproc\.html|background\.js)$/.test(target.url)) continue;
    const session = await rp.attach(target.targetId);
    result[target.url.endsWith('inproc.html') ? 'host' : 'background'] = await rp.evaluate(session, `performance.getEntriesByType('measure').filter(e=>e.name.startsWith('sideagent.startup.')).map(e=>({name:e.name,ms:e.duration,detail:e.detail}))`);
  }
  return result;
}

try {
  await attachPanel();
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector('#think-chip')?.textContent?.includes('fixture')`), 60_000, '模型目录已返回');
  // 夹具只写隔离扩展的数据；长的非主分支记录模拟实际积累的上下文，不占这次模型的窗口。
  await rp.evaluate(panel, `(async()=>{
    const open=(name,store)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore(store);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const write=(db,store,entries)=>new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');for(const [key,value] of entries)tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
    const records=await open('sideagent-session-data','items');
    const summaries=[];const entries=[];const time=Date.now();
    for(let i=0;i<${count};i++){
      const id='startup-'+i;
      summaries.push({id,title:'启动记录 '+i,createdAt:time,updatedAt:time,state:'idle',mode:'act',model:'custom/fixture',runId:null});
      const header={kind:'header',version:4,id,createdAt:time,cwd:'/'};
      const pad={kind:'entry',lane:'archive',type:'custom',customType:'fixture-padding',id:'pad-'+i,parentId:null,seq:1,timestamp:time,data:'x'.repeat(${bytes})};
      entries.push(['pi:/sessions/----/fixture_'+id+'.jsonl',{text:[header,pad].map(x=>JSON.stringify(x)).join('\\n')+'\\n',directory:false,modifiedAt:time}]);
    }
    await write(records,'items',entries);records.close();
    const catalog=await open('sideagent-conversations','kv');
    await write(catalog,'kv',[['index',summaries]]);catalog.close();
    localStorage.setItem('sideagent.thinkingLevels',JSON.stringify({'custom/fixture':'medium'}));
    return {count:summaries.length};
  })()`);

  for (let round = 0; round < rounds; round++) {
    const workerUrl = `chrome-extension://${rp.extensionId}/background.js`;
    const previousWorker = (await rp.targets()).find(t => t.url === workerUrl)?.targetId;
    const start = Date.now();
    // 扩展重载会销毁旧端口，不能等待该端口返回。
    await rp.evaluate(panel, `setTimeout(()=>chrome.runtime.reload(),100);true`);
    await until(async () => !(await rp.targets()).some(t => t.url.endsWith('/sidepanel.html') && t.url.includes(rp.extensionId)), 15_000, '旧侧栏已关闭', 50);
    await until(async () => (await rp.targets()).find(t => t.type === 'service_worker' && t.url === workerUrl && t.targetId !== previousWorker), 20_000, '重载后新后台注册', 50);
    await attachPanel();
    await until(async () => await rp.evaluate(panel, `document.querySelector('#think-chip')?.textContent?.includes('fixture') && !document.querySelector('#status-pill')?.textContent?.includes('连接中')`), 60_000, '重载后宿主与模型目录就绪', 50);
    const elapsedMs = Date.now() - start;
    const stages = await timings();
    const errors = await rp.evaluate(panel, `[...document.querySelectorAll('.msg.error')].map(e=>e.textContent)`);
    (evidence.rounds as unknown[]).push({ round, elapsedMs, stages, errors });
    console.log(JSON.stringify({ round, elapsedMs, stages, errors }));
    await writeFile(join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2));
    if (!baseline) assert.deepEqual(errors, [], '恢复不支持的档位应自动映射，不能产生对话错误');
    if (round === 0) {
      await rp.click(panel, '#conversation-switcher');
      await rp.click(panel, '[data-conversation-id="startup-0"]');
      await rp.click(panel, '#input');
      await rp.typeText(panel, remembered);
      await rp.pressEnter(panel);
      await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes('已收到核对码。') && !document.querySelector('#send-btn')?.classList.contains('stopping')`), 30_000, '真实发送写入会话');
      await until(async () => await rp.evaluate(panel, `!document.querySelector('.msg.assistant.streaming,.msg.assistant[data-revealing]') && !document.querySelector('#status-pill')?.classList.contains('running')`), 30_000, '本轮回答结束后再重载');
    }
  }

  await rp.click(panel, '#conversation-switcher');
  await until(async () => await rp.evaluate(panel, `!!document.querySelector('[data-conversation-id="startup-0"]')`), 10_000, '旧会话仍在列表');
  evidence.restoredConversations = await rp.evaluate(panel, `document.querySelectorAll('[data-conversation-id^="startup-"]').length`);
  assert.equal(evidence.restoredConversations, count, '全部旧会话仍能从界面找到');
  await rp.click(panel, '[data-conversation-id="startup-0"]');
  await rp.click(panel, '#input');
  await rp.typeText(panel, '启动核对：告诉我旧会话里的核对码。');
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes(${JSON.stringify(answer)})`), 60_000, '重载后首条消息回答');
  assert.equal(restoredInput, true, '真正发给模型的输入保留旧会话原文');
  evidence.restoredInput = restoredInput;
  await until(async () => await rp.evaluate(panel, `!document.querySelector('.msg.assistant.streaming,.msg.assistant[data-revealing]') && !document.querySelector('#status-pill')?.classList.contains('running')`), 30_000, '恢复后的回答完整显示');
  await rp.screenshot(panel, join(artifacts, 'panel.png'));
  if (!baseline) {
    // 只模拟服务商的能力目录，不调用远端模型；档位设置、恢复和显示仍走真实扩展。
    const identity = createHash('sha256').update('openai-codex\0startup-fixture').digest('hex');
    const entries = [
      { id: 'startup-low-high', name: '缺中档模型', efforts: ['low', 'high'], input: ['text'], contextWindow: 128000, discoveryOnly: false },
      { id: 'startup-high-only', name: '仅高档模型', efforts: ['high'], input: ['text'], contextWindow: 128000, discoveryOnly: false },
    ];
    const mappings: unknown[] = [];
    for (const entry of entries) {
      const items = {
        'inproc_cred:openai-codex': { type: 'oauth', access: 'fixture', refresh: '', expires: Date.now() + 3600000, accountId: 'startup-fixture' },
        inproc_codex_catalog: { identity, checkedAt: Date.now(), models: entries, discoveryComplete: true },
        inproc_model_config: { provider: 'openai-codex', modelId: entry.id },
      };
      await rp.evaluate(panel, `localStorage.setItem('sideagent.thinkingLevels',JSON.stringify({${JSON.stringify('openai-codex/' + entry.id)}:'medium'}));chrome.storage.local.set(${JSON.stringify(items)}).then(()=>true)`);
      await rp.cdp.send('Page.reload', {}, panel);
      const expected = entry.id.endsWith('high-only') ? '高' : '低';
      await until(async () => await rp.evaluate(panel, `document.querySelector('#think-chip')?.textContent?.includes(${JSON.stringify(entry.name)}) && document.querySelector('#think-chip')?.textContent?.includes(${JSON.stringify('·' + expected)})`), 20_000, `中档映射为${expected}`);
      const shown = await rp.evaluate(panel, `({chip:document.querySelector('#think-chip')?.textContent,errors:[...document.querySelectorAll('.msg.error')].map(e=>e.textContent)})`);
      assert.deepEqual((shown as { errors: unknown[] }).errors, [], '自动映射不产生聊天错误');
      mappings.push(shown);
    }
    evidence.mappings = mappings;
  }
} catch (error) {
  failure = error;
  evidence.error = error instanceof Error ? error.stack : String(error);
  evidence.targets = await rp.targets().catch(() => []);
  evidence.chromeStderr = rp.chromeStderr().slice(-4000);
  if (panel) evidence.panel = await rp.evaluate(panel, `document.body.innerText.slice(0,1500)`).catch(String);
} finally {
  evidence.status = failure ? 'FAIL' : 'PASS';
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}
console.log(JSON.stringify({ status: evidence.status, artifacts, error: failure ? String(failure) : null }));
if (failure) process.exitCode = 1;
