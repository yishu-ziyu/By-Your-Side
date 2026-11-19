import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';

requireHeadless();
const out=join(REPO,'out/acceptance/real-path',new Date().toISOString().replace(/[:.]/g,'-')+'-diagram-cited-numbers');
await mkdir(out,{recursive:true});
const ask='把这两件事放在一张图里给我核对。';
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<main><h1>11月18日</h1><p>1918年：拉脱维亚宣告独立。</p><p>1928年：汽船威利号在纽约首演。</p><p>活动编号：6459</p></main>'));
await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+siteAddress(site).port+'/';
const rule={match:ask,steps:[{text:''}]};
const model=await startScriptedModel([rule],undefined,payload=>{
  if (!payload.tools?.length) return;
  const raw=(payload.messages??[]).flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).map(v=>v.text??'')).join('\n');
  const id=/\[source:(s[0-9a-f]+)\]/.exec(raw)?.[1]??'';
  rule.steps[0]!.text=`两个事件如下。\n<card title="事件"><diagram>flowchart TB\n A["1918年<br/>拉脱维亚宣告独立"] --> B["1928年<br/>汽船威利号首演"]\n</diagram><cite node="A" source="${id}" anchor="1918年：拉脱维亚宣告独立"></cite><cite node="B" source="${id}" anchor="1928年：汽船威利号在纽约首演"></cite></card>\n活动编号是 6459。`;
});
const rp=await launchRealPath();
let ok=false;
try {
  const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.navigate',{url},work);
  await until(async()=>await rp.evaluate(work,`document.body?.innerText.includes('6459')`)||undefined,15000,'原文就绪');
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local'}})}).then(()=>true)`);
  await until(async()=>await rp.evaluate(panel,`document.querySelector('#conversation-new')?.disabled===false && document.querySelector('#send-btn')?.disabled===false`)||undefined,60000,'连接就绪');
  await rp.click(panel,'#input'); await rp.typeText(panel,ask); await rp.pressEnter(panel);
  await until(async()=>await rp.evaluate(panel,`document.querySelector('#messages .gc-diagram svg [data-cited]') && [...document.querySelectorAll('#messages .num-cite')].some(el=>el.textContent==='6459')`)||undefined,30000,'图和正文数字引用均已挂载');
  const evidence=await rp.evaluate(panel,`(() => {const a=document.querySelector('#messages .gc-diagram svg [data-id="A"]');return {visible:a?.closest('.msg')?.innerText??'',nested:a?.querySelector('.num-cite')?.outerHTML??null,cited:a?.hasAttribute('data-cited')??false};})()`) as {visible:string;nested:string|null;cited:boolean};
  ok=evidence.visible.includes('1918')&&evidence.visible.includes('1928')&&!evidence.nested&&evidence.cited;
  await rp.screenshot(panel,join(out,'diagram.png'));
  await writeFile(join(out,'result.json'),JSON.stringify({ok,evidence},null,2));
  console.log(ok?'PASS':'FAIL',out);
} finally {await rp.close();await rp.remove();await model.close();site.close();}
if(!ok)process.exitCode=1;
