import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until } from './harness.mts';

requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}-codex-model-list`);
await mkdir(out,{recursive:true});
const account=(id:string)=>({type:'oauth',access:'fixture-access',refresh:'',expires:Date.now()+3_600_000,accountId:id});
const entry=(slug:string)=>({slug,display_name:slug,visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'medium'}],input_modalities:['text'],context_window:128000});
const rp=await launchRealPath();
let error:string|undefined;
let page='';
const evidence:Record<string,unknown>={};
try {
  const helper=await rp.cdp.send('Target.createTarget',{url:`chrome-extension://${rp.extensionId}/voice-permission.html`});
  const h=await rp.attach(helper.targetId);
  await until(async()=>await rp.evaluate(h,'!!globalThis.chrome?.storage?.local')||undefined,15000,'扩展存储');
  await rp.evaluate(h,`chrome.storage.local.set(${JSON.stringify({'inproc_cred:openai-codex':account('fixture-account-a')})})`);
  const target=await rp.cdp.send('Target.createTarget',{url:'about:blank'});
  page=await rp.attach(target.targetId);
  await rp.cdp.send('Network.enable',{},page);
  const requests:string[]=[];
  const off=rp.cdp.onEvent('Fetch.requestPaused',(event:{sessionId?:string;params?:{requestId:string;request:{url:string}}})=>{
    if(event.sessionId!==page || !event.params)return;
    const version=new URL(event.params.request.url).searchParams.get('client_version') ?? '';
    requests.push(version);
    const models=[entry('fixture-account-a-only'),...(version==='999.0.0' && process.env.BREAK_CATALOG!=='1'?[entry('fixture-future')]:[])];
    void rp.cdp.send('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({models})).toString('base64')},page);
  });
  await rp.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*chatgpt.com/backend-api/codex/models*',requestStage:'Request'}]},page);
  await rp.cdp.send('Page.navigate',{url:`chrome-extension://${rp.extensionId}/settings.html`},page);
  await until(async()=>await rp.evaluate(page,`document.readyState==='complete' && !!document.querySelector('[data-settings-page="connections"]')`)||undefined,15000,'设置页');
  await rp.evaluate(page,`document.querySelector('[data-settings-page="connections"]').click()`);
  await until(async()=>await rp.evaluate(page,`!!document.querySelector('.provider-option[data-provider="openai-codex"]')`)||undefined,15000,'账号连接');
  await rp.click(page,'.provider-option[data-provider="openai-codex"]');
  const meta=()=>rp.evaluate(page,`document.querySelector('#model-meta').innerText`) as Promise<string>;
  const list=async()=>{await rp.click(page,'#model-toggle');return await rp.evaluate(page,`[...document.querySelectorAll('#model-options [role=option]')].map(o=>o.innerText.trim())`) as string[]};
  await until(async()=>String(await meta()).includes('已更新')||undefined,20000,'在线目录更新');
  assert.ok(requests.includes('0.164.0') && requests.includes('999.0.0'),'分别请求当前兼容目录和新版本目录');
  evidence.online={requests,meta:await meta(),list:await list()};
  assert.deepEqual((evidence.online as {list:string[]}).list,['fixture-account-a-only','fixture-future\n· 新模型，先验证连接']);
  await rp.evaluate(page,`document.querySelector('#model-options').hidePopover()`);
  await rp.cdp.send('Fetch.disable',{},page); off();
  await rp.cdp.send('Network.setBlockedURLs',{urls:['*chatgpt.com/backend-api/*']},page);
  await rp.click(page,'#codex-refresh');
  await until(async()=>String(await meta()).includes('更新失败')||undefined,20000,'网络失败提示');
  evidence.accountA={meta:await meta(),list:await list()};
  assert.deepEqual((evidence.accountA as {list:string[]}).list,['fixture-account-a-only','fixture-future\n· 新模型，先验证连接']);
  assert.equal(await rp.evaluate(page,`[...document.querySelectorAll('#main-model option')].some(o=>o.value.includes('fixture-future'))`),false,'未经验证的新模型不能直接选为主模型');
  await rp.click(page,'#model-options [data-id="fixture-future"]');
  await rp.click(page,'#model-save');
  const unverified=await until(async()=>{const x=String(await rp.evaluate(page,`document.querySelector('#model-status').innerText`));return x.includes('新模型需要先通过连接测试')?x:undefined;},20000,'新模型连接失败不得保存');
  evidence.unverified=unverified;
  await rp.click(page,'#model-toggle');
  assert.match((evidence.accountA as {meta:string}).meta,/显示上次结果/);
  await rp.screenshot(page,join(out,'account-a-offline.png'));
  await rp.evaluate(page,`location.reload()`);
  await until(async()=>await rp.evaluate(page,`!!document.querySelector('[data-settings-page="connections"]')`)||undefined,15000,'重开设置');
  await rp.evaluate(page,`document.querySelector('[data-settings-page="connections"]').click()`);
  await until(async()=>await rp.evaluate(page,`!!document.querySelector('.provider-option[data-provider="openai-codex"]')`)||undefined,15000,'重开连接');
  await rp.click(page,'.provider-option[data-provider="openai-codex"]');
  await until(async()=>String(await meta()).includes('更新失败')||undefined,20000,'重开后的失败提示');
  evidence.reopened={meta:await meta(),list:await list()};
  assert.deepEqual((evidence.reopened as {list:string[]}).list,['fixture-account-a-only','fixture-future\n· 新模型，先验证连接']);
  await rp.evaluate(page,`document.querySelector('#model-options').hidePopover()`);
  await rp.evaluate(page,`chrome.storage.local.set({inproc_model_config:{provider:'openai-codex',modelId:'fixture-account-a-only'}})`);
  await until(async()=>await rp.evaluate(page,`chrome.storage.local.get('inproc_model_config').then(x=>x.inproc_model_config?.modelId==='fixture-account-a-only')`)||undefined,10000,'保存选择');
  await rp.evaluate(page,`chrome.storage.local.set(${JSON.stringify({'inproc_cred:openai-codex':account('fixture-account-b')})})`);
  await until(async()=>String(await meta()).includes('显示内置列表')||undefined,20000,'切换账号更新状态');
  assert.equal(await rp.evaluate(page,`chrome.storage.local.get('inproc_codex_catalog').then(x=>x.inproc_codex_catalog === undefined)`),true,'切换账号后清除上一账号的目录缓存');
  evidence.accountB={meta:await meta(),list:await list()};
  const retained=(evidence.accountB as {list:string[]}).list.find(item=>item.includes('fixture-account-a-only'));
  assert.ok(retained?.includes('未确认当前账号可用'),'用户保存的模型仍可见，但不能当成新账号目录');
  assert.match((evidence.accountB as {meta:string}).meta,/显示内置列表/);
  await rp.screenshot(page,join(out,'account-b-offline.png'));
} catch(e) {
  error=e instanceof Error?e.stack??e.message:String(e);
  if (typeof page === 'string' && page) {
    evidence.failure=await rp.evaluate(page,`({meta:document.querySelector('#model-meta')?.innerText,dialog:document.querySelector('#connection-dialog')?.open,body:document.body.innerText.slice(-1500)})`).catch(()=>null);
    await rp.screenshot(page,join(out,'failure.png')).catch(()=>{});
  }
}
finally { await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2)); await rp.close(); await rp.remove(); }
console.log(JSON.stringify({status:error?'FAIL':'PASS',error,evidence,out}));
if(error)process.exitCode=1;
