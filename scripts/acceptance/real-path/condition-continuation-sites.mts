/**
 * Public-site pilot: real Wikipedia search suggestions + real logged-in model.
 * Delays the original suggestion request until BYS has persisted a condition wait;
 * never supplies a fixture response or changes Wikipedia's result data.
 * npx tsx scripts/acceptance/real-path/condition-continuation-sites.mts --headless --site=wikipedia
 * Only Wikipedia is implemented and source-checked; other sites fail explicitly.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, sleep, until, watchInproc } from './harness.mts';
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from './inproc-config.mts';
import { redactCredentialText } from '../../../shared/untrusted.js';
import type { TaskView } from '../../../shared/task-view.js';

requireHeadless();
const site = process.argv.find(arg => arg.startsWith('--site='))?.slice(7) ?? 'wikipedia';
assert.equal(site, 'wikipedia', 'only the source-checked Wikipedia pilot is implemented');
const modelName = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? DEFAULT_TEST_MODEL;
const HOME = 'https://en.wikipedia.org/wiki/Main_Page';
const TERM = 'Shenzhen';
const ASK = `在这个维基百科首页的搜索框输入搜索词 ${TERM}，不要回车、不要跳转。等真实搜索建议加载完成后，仅把建议标题含 ${TERM} 的条目标在页面上，并说明筛选依据。三分钟内完成。`;
const artifacts = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-condition-continuation-sites-wikipedia`);
await mkdir(artifacts, { recursive: true });
const phases: Array<{ at: number; phase: string; detail?: unknown }> = [];
const log = (phase: string, detail?: unknown) => { const entry = { at: Date.now(), phase, ...(detail === undefined ? {} : { detail }) }; phases.push(entry); console.log(JSON.stringify(entry)); };
const stage = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
  log(`${name}：开始`);
  try { const value = await run(); log(`${name}：完成`); return value; }
  catch (error) { log(`${name}：失败`, redactCredentialText(String(error)).slice(0, 1800)); throw error; }
};
type Suggestion = { title: string; href: string; text: string; rect: { x: number; y: number; width: number; height: number } };
type ApiRecord = { requestId: string; at: number; url: string; query: string; status?: number; completedAt?: number; body?: string; error?: string };
type HeldRequest = { id: string; query: string; url: string; at: number; releasedAt?: number; error?: string };
type MarkState = { label: string; element: { name: string } | null; shown: boolean };
type MarkBox = { x: number; y: number; width: number; height: number };
type SearchInputFact = { id: string; name: string; type: string; visible: boolean; value: string; controls: string | null; owns: string | null };
const suggestionQuery = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'en.wikipedia.org') return null;
    if (url.pathname === '/w/rest.php/v1/search/title') return url.searchParams.get('q');
    if (url.pathname === '/w/api.php' && url.searchParams.get('action') === 'opensearch') return url.searchParams.get('search');
  } catch { /* unrelated URL */ }
  return null;
};
const publicApiUrl = (raw: string): string => {
  const source = new URL(raw), clean = new URL(source.origin + source.pathname);
  for (const key of ['action', 'q', 'search', 'limit', 'format', 'formatversion']) {
    const value = source.searchParams.get(key);
    if (value !== null) clean.searchParams.set(key, value);
  }
  return clean.href;
};
const isModelRequest = (request: { url: string; method: string }) => request.method === 'POST' && /(?:\/responses|\/chat\/completions|\/messages|\/completions)(?:[/?]|$)/.test(request.url);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let network: Awaited<ReturnType<typeof watchInproc>> | undefined;
let work = '', panel = '', error: string | null = null;
let released = false, waiting: TaskView | undefined, completed: TaskView | undefined;
let views: TaskView[] = [], suggestions: Suggestion[] = [], apiTitles: string[] = [];
let markStates: MarkState[] = [], markBoxes: MarkBox[] = [], layerCount = 0, inputValue = '', finalText = '';
let searchInputs: SearchInputFact[] = [];
let quietWindow: { from: number; to: number; before: number; after: number } | null = null;
let releaseAt: number | null = null, deliveredAt: number | null = null;
const pending = new Map<string, HeldRequest>(), intercepted: HeldRequest[] = [], api = new Map<string, ApiRecord>();
const contexts = new Set<number>(), responseReads = new Set<Promise<void>>();
const navigation: Array<{ at: number; url: string }> = [];
let stopPausedListener: (() => void) | undefined;
const countModels = () => network?.requestsBetween(0).filter(isModelRequest).length ?? 0;

try {
  rp = await stage('启动隔离真实扩展', () => launchRealPath());
  const browser = rp;
  const blank = await until(async () => (await browser.targets()).find(target => target.type === 'page' && target.url === 'about:blank'), 10_000, 'isolated work tab');
  work = await browser.attach(blank.targetId);
  browser.cdp.onEvent('Runtime.executionContextCreated', (event: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (event.sessionId === work && event.params.context.auxData?.type === 'isolated' && event.params.context.origin.startsWith('chrome-extension://')) contexts.add(event.params.context.id);
  });
  browser.cdp.onEvent('Runtime.executionContextDestroyed', (event: { sessionId?: string; params: { executionContextId: number } }) => { if (event.sessionId === work) contexts.delete(event.params.executionContextId); });
  browser.cdp.onEvent('Runtime.executionContextsCleared', (event: { sessionId?: string }) => { if (event.sessionId === work) contexts.clear(); });
  browser.cdp.onEvent('Page.frameNavigated', (event: { sessionId?: string; params: { frame: { parentId?: string; url: string } } }) => {
    if (event.sessionId === work && !event.params.frame.parentId) navigation.push({ at: Date.now(), url: event.params.frame.url });
  });
  await browser.cdp.send('Runtime.enable', {}, work);
  await browser.cdp.send('Page.enable', {}, work);
  await browser.cdp.send('Network.enable', {}, work);
  stopPausedListener = browser.cdp.onEvent('Fetch.requestPaused', (event: { sessionId?: string; params: { requestId: string; request: { url: string } } }) => {
    if (event.sessionId !== work) return;
    const { requestId, request } = event.params, query = suggestionQuery(request.url);
    const matching = query !== null && query.length > 0 && TERM.toLowerCase().startsWith(query.toLowerCase());
    if (!matching || released) { void browser.cdp.send('Fetch.continueRequest', { requestId }, work).catch(() => {}); return; }
    const entry: HeldRequest = { id: requestId, query, url: publicApiUrl(request.url), at: Date.now() };
    pending.set(requestId, entry); intercepted.push(entry);
    log('已暂缓真实搜索建议请求', { query, url: entry.url, count: pending.size });
  });
  browser.cdp.onEvent('Network.responseReceived', (event: { sessionId?: string; params: { requestId: string; response: { url: string; status: number } } }) => {
    if (event.sessionId !== work) return;
    const query = suggestionQuery(event.params.response.url);
    if (query?.toLowerCase() === TERM.toLowerCase()) api.set(event.params.requestId, { requestId: event.params.requestId, at: Date.now(), query, url: publicApiUrl(event.params.response.url), status: event.params.response.status });
  });
  browser.cdp.onEvent('Network.loadingFinished', (event: { sessionId?: string; params: { requestId: string } }) => {
    if (event.sessionId !== work) return;
    const record = api.get(event.params.requestId);
    if (!record) return;
    const read = (async () => {
      try {
        const body = await browser.cdp.send('Network.getResponseBody', { requestId: event.params.requestId }, work) as { body: string; base64Encoded?: boolean };
        record.body = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        record.completedAt = Date.now();
      } catch (caught) { record.error = redactCredentialText(String(caught)); }
    })();
    responseReads.add(read); void read.finally(() => responseReads.delete(read));
  });
  await browser.cdp.send('Fetch.enable', { patterns: [
    { urlPattern: 'https://en.wikipedia.org/w/rest.php/v1/search/title*', requestStage: 'Request' },
    { urlPattern: 'https://en.wikipedia.org/w/api.php*', requestStage: 'Request' },
  ] }, work);
  await stage('打开公开维基百科首页', () => browser.cdp.send('Page.navigate', { url: HOME }, work));
  await stage('核对真实首页和搜索输入框', () => until(async () => {
    const data = await browser.evaluate(work, `({url:location.href,ready:document.readyState,title:document.title,input:!!document.querySelector('input[name="search"],input[type="search"]'),body:document.body?.innerText.slice(0,700)??''})`) as { url: string; ready: string; title: string; input: boolean; body: string };
    if (/captcha|access denied|site unavailable|verify you are human/i.test(data.body)) throw new Error(`公开站点不可用：${data.body}`);
    return data.url === HOME && data.ready !== 'loading' && data.input ? data : undefined;
  }, 45_000, 'real Wikipedia search form'));
  await browser.screenshot(work, join(artifacts, 'before-page.png'));
  panel = await stage('打开真实侧栏', async () => browser.attach(await browser.openSidePanel()));
  await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel);
  await stage('配置用户授权的真实模型和自用隔离', async () => {
    const settings = modelStorageItems(await loadModelPlan(modelName));
    await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...settings, continuousDelegation: true, sideagent_self_use: { until: Date.now() + 600_000 } })}).then(()=>true)`);
  });
  await until(() => browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, 'sidebar ready');
  network = await stage('观察真实模型调用元数据', () => watchInproc(browser, browser.extensionId));
  await browser.evaluate(panel, `(() => {
    globalThis.__siteContinuationViews=[];globalThis.__siteContinuationMessages=[];
    const port=chrome.runtime.connect({name:'sideagent-panel'});globalThis.__siteContinuationPort=port;
    port.onMessage.addListener(message=>{globalThis.__siteContinuationMessages.push(message);if(message.kind==='server'&&message.msg?.type==='task_view')globalThis.__siteContinuationViews.push(message.msg.view)});
    port.postMessage({kind:'sync',afterSeq:0});return true;
  })()`);
  const readViews = async () => await browser.evaluate(panel, 'globalThis.__siteContinuationViews??[]') as TaskView[];
  let stateKey = '', loggedAt = 0;
  const latest = async () => {
    const view = (await readViews()).findLast(item => item.goal?.includes(TERM));
    const key = `${view?.state??'none'}/${view?.continuation?.state??'未登记'}`;
    if (key !== stateKey || Date.now() - loggedAt > 10_000) { stateKey = key; loggedAt = Date.now(); log('当前权威任务状态', { state: key, requests: countModels(), pendingSuggestions: pending.size, lastError: view?.continuation?.lastError??null }); }
    if (view?.state === 'error') {
      const visible = redactCredentialText(String(await browser.evaluate(panel, 'document.querySelector("#messages")?.innerText??""'))).slice(-1400);
      const errors = redactCredentialText(network?.logs()??'').split('\n').filter(line => /error|failed|失败|错误/i.test(line)).slice(-5);
      throw new Error(`任务已终止：${visible}; ${errors.join(' / ')}`);
    }
    return view;
  };
  const probe = async <T,>(expression: string): Promise<T | undefined> => {
    for (const contextId of contexts) {
      const reply = await browser.cdp.send('Runtime.evaluate', { contextId, returnByValue: true, expression: `(()=>{const ns=globalThis.__sideagent;return ns?.marksState?(${expression}):undefined})()` }, work).catch(() => null) as { result?: { value?: T } } | null;
      if (reply?.result?.value !== undefined) return reply.result.value;
    }
    return undefined;
  };
  await stage('用户只交代一次真实站点目标', async () => { await browser.click(panel, '#input'); await browser.typeText(panel, ASK); await browser.pressEnter(panel); });
  await stage('等待真实建议接口被暂缓', () => until(async () => {
    await latest();
    return [...pending.values()].find(item => item.query.toLowerCase() === TERM.toLowerCase());
  }, 120_000, 'real Shenzhen suggestion API request; no synthetic fallback'));
  searchInputs = await stage('核对真实可见搜索输入框的值', () => browser.evaluate(work, `Array.from(document.querySelectorAll('input[name="search"],input[type="search"]')).map(input=>{
    const style=getComputedStyle(input);return{id:input.id,name:input.name,type:input.type,value:input.value,
      visible:input.getClientRects().length>0&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&style.display!=='none',
      controls:input.getAttribute('aria-controls'),owns:input.getAttribute('aria-owns')};
  })`) as Promise<SearchInputFact[]>);
  log('真实搜索输入框读数', searchInputs);
  const matchingInputs = searchInputs.filter(input => input.visible && input.value === TERM);
  assert.equal(matchingInputs.length,1,'exactly one real visible search input holds Shenzhen; hidden legacy inputs are not the oracle');
  inputValue = matchingInputs[0]!.value;
  assert.equal(inputValue, TERM, 'the real model filled Shenzhen in the real search box');
  assert.equal(await browser.evaluate(work, 'location.href'), HOME, 'typing did not submit or navigate');
  waiting = await stage('等待持久登记页面条件并释放执行资源', () => until(async () => { const view = await latest(); return view?.continuation?.state==='WAITING_CONDITION' ? view : undefined; }, 120_000, 'condition registration while real result remains pending'));
  assert.ok(waiting.runId, 'the condition is bound to the original accepted task');
  assert.equal(waiting.continuation!.url, HOME, 'observation is bound to the real home page');
  await until(() => browser.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")'), 20_000, 'execution fragment released');
  await sleep(750);
  const quietFrom = Date.now(), before = countModels();
  await stage('确认真实结果未到时不消耗模型轮询', () => sleep(4500));
  quietWindow = { from: quietFrom, to: Date.now(), before, after: countModels() };
  assert.equal(quietWindow.after, before, 'real pending condition sends zero model requests');
  assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'unreceived network response cannot wake execution');
  assert.equal(await probe<number>('ns.markLayerCount()')??0,0,'no suggestion is marked before the real result arrives');
  await browser.screenshot(work, join(artifacts, 'waiting-page.png')); await browser.screenshot(panel, join(artifacts, 'waiting-panel.png'));
  releaseAt = Date.now(); released = true;
  await stage('放行原始真实建议请求', async () => {
    for (const [id, entry] of [...pending]) {
      try { await browser.cdp.send('Fetch.continueRequest', { requestId: id }, work); entry.releasedAt = Date.now(); }
      catch (caught) { entry.error = redactCredentialText(String(caught)); }
      pending.delete(id);
    }
  });
  const response = await stage('读取真实搜索接口返回的原始结果', () => until(async () => {
    await latest();
    return [...api.values()].findLast(item => item.status === 200 && item.body && item.completedAt! >= releaseAt!);
  }, 60_000, 'genuine Wikipedia suggestion response'));
  const parsed: unknown = JSON.parse(response.body!);
  apiTitles = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1].filter((value): value is string => typeof value==='string')
    : parsed && typeof parsed==='object' && Array.isArray((parsed as { pages?: unknown }).pages)
      ? (parsed as { pages: unknown[] }).pages.flatMap(page => page && typeof page==='object' && typeof (page as { title?: unknown }).title==='string' ? [(page as { title: string }).title] : []) : [];
  assert.ok(apiTitles.length, 'the real endpoint returned a supported, nonempty suggestion payload');
  const readSuggestions = async () => await browser.evaluate(work, `(() => {
    const titles=${JSON.stringify(apiTitles)}, normal=value=>String(value??'').replaceAll('_',' ').trim();
    const visible=node=>{const s=getComputedStyle(node);return node.getClientRects().length>0&&s.visibility!=='hidden'&&s.display!=='none'};
    const inputs=[...document.querySelectorAll('input[name="search"],input[type="search"]')].filter(input=>visible(input)&&input.value===${JSON.stringify(TERM)});
    const menuIds=inputs.flatMap(input=>[input.getAttribute('aria-controls'),input.getAttribute('aria-owns')].filter(Boolean).flatMap(value=>value.split(/\\s+/)));
    const linkedMenus=menuIds.map(id=>document.getElementById(id)).filter(Boolean);
    const menus=linkedMenus.length?linkedMenus:[...document.querySelectorAll('.cdx-typeahead-search__menu')];
    for(const menu of menus.filter(visible)){const nodes=[...menu.querySelectorAll('.cdx-menu-item[role="option"]')].filter(visible);const found=[];
      for(const node of nodes){const anchor=node.matches('a')?node:node.querySelector('a[href]');if(!anchor)continue;
        const href=anchor.href,url=new URL(href,location.href);if(url.hostname!=='en.wikipedia.org')continue;
        if(node.querySelector('.cdx-typeahead-search__search-footer')||url.searchParams.get('fulltext')==='1')continue;
        const pathTitle=url.pathname.startsWith('/wiki/')?decodeURIComponent(url.pathname.slice(6)):url.searchParams.get('search')??url.searchParams.get('title');
        const label=node.querySelector('.cdx-menu-item__text__label,.cdx-menu-item__label')?.textContent??anchor.getAttribute('title');
        const title=titles.find(title=>normal(title)===normal(label))??titles.find(title=>normal(title)===normal(pathTitle));if(!title)continue;
        const r=node.getBoundingClientRect();found.push({title,href,text:(node.innerText??node.textContent??'').trim(),rect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}});
      }if(found.length)return found;
    }return [];
  })()`) as Suggestion[];
  suggestions = await stage('独立读取网页实际展示的建议标题', () => until(async () => { const items=await readSuggestions(); return items.length ? items : undefined; }, 30_000, 'supported visible suggestion DOM; no guessed synthetic result'));
  assert.equal(new Set(suggestions.map(item=>item.title)).size, suggestions.length, 'visible suggestions have unique canonical titles');
  completed = await stage('等待真实模型自动筛选并核对交付', () => until(async () => { const view=await latest(); return view?.continuation?.state==='COMPLETED'?view:undefined; }, 180_000, 'real site goal verified'));
  deliveredAt = Date.now(); await sleep(4500);
  views = await readViews(); markStates = await probe<MarkState[]>('ns.marksState()') ?? []; markBoxes = await probe<MarkBox[]>('ns.markLayout()') ?? []; layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
  finalText = String(await browser.evaluate(panel, 'document.querySelector("#messages")?.innerText??""'));
  const expected = suggestions.filter(item=>item.title.includes(TERM));
  assert.ok(expected.length, 'the real response produced at least one qualifying visible suggestion');
  assert.equal(layerCount, expected.length, 'the actual annotation layer has exactly one mark per qualifying visible suggestion');
  assert.equal(markStates.length, layerCount, 'annotation facts agree with real layer child count');
  assert.ok(markStates.every(mark=>mark.shown), 'all delivered annotations remain visible');
  const assignments = markBoxes.map(box=>{
    const center={x:box.x+box.width/2,y:box.y+box.height/2};
    const matches=suggestions.filter(item=>center.x>=item.rect.x-8&&center.x<=item.rect.x+item.rect.width+8&&center.y>=item.rect.y-8&&center.y<=item.rect.y+item.rect.height+8&&box.width<=item.rect.width+64&&box.height<=item.rect.height+64);
    assert.equal(matches.length,1,'each real mark is anchored to exactly one actual suggestion row');return matches[0]!.title;
  });
  assert.deepEqual([...assignments].sort(), expected.map(item=>item.title).sort(), 'every qualifying title is marked and no other suggestion is marked');
  assert.equal(completed.runId, waiting.runId, 'wake retains the original accepted run');
  assert.ok(completed.continuation?.processedVersion, 'verified observed version is saved as processed');
  const wakeIds = new Set(views.filter(view=>view.continuation?.id===waiting!.continuation!.id).map(view=>view.continuation?.requestId).filter(Boolean));
  assert.equal(wakeIds.size,1,'one real network result causes only one admitted execution segment');
  assert.equal(await browser.evaluate(panel, 'document.querySelectorAll("#messages .msg.user").length'), 1, 'the user never had to send a continue prompt');
  assert.equal(await browser.evaluate(work,'location.href'), HOME, 'the real website was never submitted or navigated');
  assert.ok(navigation.every(item=>item.url===HOME||item.url==='about:blank'),'no transient search-result navigation occurred');
  assert.ok(finalText.includes(TERM), 'the visible answer identifies the real selected title criterion');
  assert.ok(network.requestsBetween(0).some(isModelRequest),'the network instrumentation observed actual model traffic');
  await browser.screenshot(work,join(artifacts,'after-page.png'));await browser.screenshot(panel,join(artifacts,'after-panel.png'));
  log('真实网站独立核验完成',{expected:expected.map(item=>item.title),marked:assignments,layerCount});
} catch (caught) {
  error=redactCredentialText(caught instanceof Error?caught.stack??caught.message:String(caught));log('真实站点验收失败',error.split('\n')[0]);
  if(rp&&work)await rp.screenshot(work,join(artifacts,'failure-page.png')).catch(()=>{});
  if(rp&&panel)await rp.screenshot(panel,join(artifacts,'failure-panel.png')).catch(()=>{});
} finally {
  // Never leave a public-site request paused after either a success or a failed assertion.
  released=true;
  if(rp&&work){for(const[id,entry]of[...pending]){try{await rp.cdp.send('Fetch.continueRequest',{requestId:id},work);entry.releasedAt=Date.now()}catch(caught){entry.error=redactCredentialText(String(caught))}pending.delete(id)}await rp.cdp.send('Fetch.disable',{},work).catch(()=>{})}
  stopPausedListener?.();await Promise.allSettled([...responseReads]);
  if(rp&&panel){views=await rp.evaluate(panel,'globalThis.__siteContinuationViews??[]').catch(()=>views) as TaskView[];await rp.evaluate(panel,'globalThis.__siteContinuationPort?.disconnect();true').catch(()=>{});if(!finalText)finalText=redactCredentialText(String(await rp.evaluate(panel,'document.querySelector("#messages")?.innerText??""').catch(()=>'')))}
  const modelNetwork=network?.requestsBetween(0).filter(isModelRequest).map(request=>{const url=new URL(request.url);return{...request,url:`${url.origin}${url.pathname}`}})??[];
  await writeFile(join(artifacts,'site-suggestions.json'),JSON.stringify({source:HOME,term:TERM,searchInputs,apiTitles,displayed:suggestions,marks:markStates,geometry:markBoxes},null,2));
  await writeFile(join(artifacts,'real-site-api.json'),JSON.stringify([...api.values()],null,2));
  await writeFile(join(artifacts,'model-network.json'),JSON.stringify(modelNetwork,null,2));
  await writeFile(join(artifacts,'task-views.json'),JSON.stringify(views,null,2));
  await writeFile(join(artifacts,'stages.jsonl'),phases.map(entry=>JSON.stringify(entry)).join('\n'));
  await writeFile(join(artifacts,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',site,model:modelName,dependency:'real Wikipedia DOM and original search API response; real model and checker; isolated extension; network delivery delay only',sourceReferences:[HOME,'https://en.wikipedia.org/w/load.php?lang=en&modules=skins.vector.search&only=scripts&raw=1&skin=vector-2022','https://en.wikipedia.org/w/load.php?lang=en&modules=mediawiki.skinning.typeaheadSearch&only=scripts&raw=1&skin=vector-2022','https://en.wikipedia.org/w/load.php?lang=en&modules=mediawiki.codex.typeaheadSearch&only=scripts&raw=1&skin=vector-2022'],waiting,completed,lastTaskView:views.at(-1)??null,inputValue,searchInputs,intercepted,quietWindow,apiTitles,suggestions,layerCount,markStates,markBoxes,navigation,releaseAt,deliveredAt,resultToVerifiedMs:releaseAt&&deliveredAt?deliveredAt-releaseAt:null,finalText,error},null,2));
  await rp?.close();await rp?.remove();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',site,artifacts,qualifying:suggestions.filter(item=>item.title.includes(TERM)).length,layerCount,error:error?.split('\n')[0]??null},null,2));
if(error)process.exitCode=1;
