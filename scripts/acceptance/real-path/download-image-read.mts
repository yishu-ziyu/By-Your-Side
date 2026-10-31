import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-download-image-read`);
await mkdir(out, {recursive:true});
const original=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=','base64');
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'image/png','content-length':original.length}).end(original));
await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${siteAddress(site).port}`;
const task='下载这张封面并直接读取下载的原图。';
const answer='下载的封面原图已读到。';
const reply={text:'图片没有完整送达。'};
let evidence:Record<string,unknown>={};
const model=await startScriptedModel([
 {match:'USER REQUEST:',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'"goalPage"',steps:[{text:JSON.stringify({status:'done',remaining:null})}]},
 {match:task,steps:[{tool:{name:'download_url',args:{url:base+'/original.png',filename:'retained-cover.png'}}},{tool:{name:'read_attachment',args:{name:'retained-cover.png'}}},reply]},
],undefined,payload=>{
 if(!payload.tools?.length)return;
 const text=JSON.stringify(payload.messages);
 const images=(payload.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='image_url').map((p:any)=>p.image_url.url):[]);
 if(!images.length)return;
 const mapped=text.includes('retained-cover.png')&&images.includes('data:image/png;base64,'+original.toString('base64'));
 const distinct=new Set(images).size;
 evidence={images:images.length,distinct,mapped};
 reply.text=images.length===1&&mapped?answer:'图片没有完整送达。';
});
const rp=await launchRealPath();let panel='',failure='';
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'stepfun',modelId:'step-3.7-flash'},inproc_fast_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:stepfun':{type:'api_key',key:'fixture'},'inproc_cred:custom':{type:'api_key',key:'fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'侧栏就绪');
 const host=await until(async()=>(await rp.targets()).find(t=>t.url.endsWith('/inproc.html')),30000,'后台宿主');
 const hs=await rp.attach(host.targetId);
 rp.cdp.onEvent('Fetch.requestPaused',(e:any)=>{if(e.sessionId!==hs)return;void(async()=>{
  const r=await fetch(`${model.baseUrl}/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:e.params.request.postData});
  await rp.cdp.send('Fetch.fulfillRequest',{requestId:e.params.requestId,responseCode:r.status,responseHeaders:[{name:'Content-Type',value:'text/event-stream'}],body:Buffer.from(await r.arrayBuffer()).toString('base64')},hs);
 })().catch(error=>console.error('fixture transport',String(error)));});
 await rp.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*api.stepfun.com/*/chat/completions*',requestStage:'Request'}]},hs);
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(async()=>{
  const text=String(await rp.evaluate(panel,`document.querySelector('#messages')?.innerText`));
  if(text.includes('图片没有完整送达。'))throw Error('下载原图没有交给模型');
  return text.includes(answer);
 },45000,'下载原图到达模型并显示结果');
 assert.equal(evidence.images,1);assert.equal(evidence.mapped,true);
 await rp.screenshot(panel,join(out,'answer.png'));
}catch(error){failure=String(error);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',failure,evidence},null,2));await rp.close();await rp.remove();await model.close();site.close();}
console.log(JSON.stringify({out,failure,evidence}));if(failure)process.exitCode=1;
