/** Download -> read_attachment -> original image pixels and visible answer; no browser image tab or screenshot is needed. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-download-image-read`);
await mkdir(out,{recursive:true});
const TASK='下载资料页的图片，直接读取下载原件并告诉我内容';
const ANSWER='已直接读取下载的图片原件，没有打开图片标签页。';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
let downloads=0,originalReached=false;
const site=createServer((req,res)=>{if(req.url==='/sample.png'){downloads++;res.writeHead(200,{'content-type':'image/png','content-length':png.length}).end(png);return;}res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<title>图片资料</title><a href="/sample.png">下载原图</a>');});
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}`;
const fact={text:'{"problems":[]}'};
let evidence:{images:number;text:string}[]=[];
const model=await startScriptedModel([
 {match:'USER REQUEST:',steps:[fact]},
 {match:'Resolve these internal evidence',steps:[{text:'图像结论被错误撤回。'}]},
 {match:'"lastReply"',steps:[{text:'{"status":"done","remaining":null}'}]},
 {match:TASK,steps:[
  {tool:{name:'navigate',args:{url:origin+'/'}}},{tool:{name:'download_url',args:{url:origin+'/sample.png',filename:'sample.png'}}},
  {tool:{name:'read_attachment',args:{name:'sample.png'}}},{text:ANSWER}
 ]},
],undefined,payload=>{
 for(const m of payload.messages??[]){
  if(payload.tools?.length&&Array.isArray(m.content)&&m.content.some((p:any)=>p.type==='image_url'&&p.image_url?.url==='data:image/png;base64,'+png.toString('base64')))originalReached=true;
  if(m.role!=='user')continue;
  const parts=Array.isArray(m.content)?m.content:[];
  const text=typeof m.content==='string'?m.content:parts.map(p=>p.text??'').join('');
  if(!text.includes('USER REQUEST:'))continue;
  const images=parts.filter(p=>p.type==='image_url').length;
  evidence.push({images,text});
  fact.text=JSON.stringify({problems:images===1?[]:[{kind:'insufficient_evidence',claim:ANSWER,source:null,quote:null,text:'核对请求缺少下载的原图'}]});
 }
});
const rp=await launchRealPath();let error='';let panel='';
const progress=setInterval(()=>console.log(JSON.stringify({phase:'image-evidence',checks:evidence.length})),30000);
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'stepfun',modelId:'step-3.7-flash'},inproc_fast_model_config:{provider:'stepfun',modelId:'step-3.7-flash'},'inproc_cred:stepfun':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 const host=await until(async()=>(await rp.targets()).find(t=>t.url.endsWith('/inproc.html')),30000,'后台宿主');
 const hs=await rp.attach(host.targetId);
 rp.cdp.onEvent('Fetch.requestPaused',(e:any)=>{if(e.sessionId!==hs)return;void(async()=>{
  const r=await fetch(`${model.baseUrl}/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:e.params.request.postData});
  await rp.cdp.send('Fetch.fulfillRequest',{requestId:e.params.requestId,responseCode:r.status,responseHeaders:[{name:'Content-Type',value:r.headers.get('content-type')??'application/json'}],body:Buffer.from(await r.arrayBuffer()).toString('base64')},hs);
 })().catch(err=>{error=String(err);console.error('fixture transport failed',error);});});
 await rp.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*api.stepfun.com/*/chat/completions*',requestStage:'Request'}]},hs);
 await rp.click(panel,'#input');await rp.typeText(panel,TASK);await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,`!!document.querySelector('.msg.assistant[data-fact-checked]')`),120000,'fact check delivered');
 assert.ok(evidence.length>0,'fact checker called');
 assert.ok(originalReached,'the actual original bytes must reach the main model');
 assert.equal(evidence[0]!.images,1,'checker receives the original image too');
 assert.ok(evidence[0]!.text.includes('sample.png'),'filename preserved');
 assert.equal(downloads,1,'only one download request');
 assert.equal((await rp.targets()).filter(t=>t.url.includes('/sample.png')).length,0,'no image browser tab');
 const visible=String(await rp.evaluate(panel,`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.checkVisibility()).map(e=>e.innerText).join(' | ')`));
 assert.ok(visible.includes(ANSWER)&&!visible.includes('撤回')&&!visible.includes('无法确认'),'supported image answer remains visible');
 await rp.screenshot(panel,join(out,'answer.png'));
}catch(e){error=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{clearInterval(progress);await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence,originalReached,downloads},null,2));await rp.close();await rp.remove();await model.close();site.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',error,out}));if(error)process.exitCode=1;
