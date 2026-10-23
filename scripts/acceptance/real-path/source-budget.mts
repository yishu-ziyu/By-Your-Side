import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-source-budget`);
await mkdir(out,{recursive:true});
const markers=['SOURCE_ALPHA_FACT','SOURCE_BETA_FACT','SOURCE_GAMMA_FACT'];
const site=createServer((req,res)=>{
 const index=Number(req.url?.slice(1))||0;
 const paragraphs=Array.from({length:40},(_,i)=>`<p>${i===8?markers[index]:''} Paragraph ${i}. ${'Ordinary source material. '.repeat(7)}</p>`).join('');
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>Source ${index}</title><main><h1>Source ${index}</h1>${paragraphs}</main>`);
});
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}`;
const task='读取三页并回答每页的标记';
const reply={text:''};
const checks:Array<{observations:Array<{tool:string;text:string}>;page?:{text?:string}}> = [];
const model=await startScriptedModel([
 {match:'"lastReply"',steps:[reply]},
 {match:task,steps:[{tool:{name:'browser_run',args:{label:'读取三个来源',code:`const a=await browser.navigate({url:${JSON.stringify(origin+'/0')}});const b=await browser.navigate({url:${JSON.stringify(origin+'/1')}});const c=await browser.navigate({url:${JSON.stringify(origin+'/2')}});return {alpha:a.text.slice(0,6500),beta:b.text.slice(0,6500),gamma:c.text.slice(0,6500)};`}}},{text:markers.join('；')}]},
],undefined,payload=>{
 if(payload.tools?.length)return;
 for(const message of payload.messages??[]){
  if(message.role!=='user'||typeof message.content!=='string')continue;
  try{
   const input=JSON.parse(message.content);
   if(!input.lastReply||!Array.isArray(input.observations))continue;
   checks.push(input);
   const text=input.observations.map((x:{text:string})=>x.text).join('\n');
   const complete=markers.every(marker=>text.includes(marker));
   reply.text=JSON.stringify({status:complete?'done':'open',remaining:complete?'':'来源证据不足',items:[{text:'三页来源证据',done:complete}]});
  }catch{}
 }
});
const rp=await launchRealPath();let panel='',error='';
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(async()=>checks.length>0,120000,'goal check');
 const receipt=checks[0]!.observations.find(x=>x.tool==='browser_run');
 assert.ok(receipt,'actual browser program result reaches check');
 for(const marker of markers)assert.ok(receipt.text.includes(marker),`missing ${marker}`);
 assert.ok(receipt.text.length<=8000,`receipt grew to ${receipt.text.length}`);
 for(let i=0;i<3;i++)assert.ok(receipt.text.includes(origin+'/'+i),`missing source URL ${i}`);
 await until(()=>rp.evaluate(panel,`document.body.innerText.includes('已核对页面')`),45000,'visible checked result');
 await rp.screenshot(panel,join(out,'checked.png'));
}catch(e){error=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{
 await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,checks,requests:model.requests,dependency:'real extension and local pages; scripted model'},null,2));
 await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));
}
console.log(JSON.stringify({status:error?'fail':'pass',error,out}));if(error)process.exitCode=1;
