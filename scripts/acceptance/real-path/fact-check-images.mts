/** Real extension screenshot -> evidence checker -> visible answer; a text-only checker must fail this regression. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-fact-check-images`);
await mkdir(out,{recursive:true});
const TASK='读两张画布图片上的专辑名字并告诉我';
const ANSWER='第一张专辑是 BLUE HARBOR，第二张专辑是 SILVER FIELD。';
const site=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<!doctype html><title>封面 ${req.url==='/one'?'一':'二'}</title><canvas width="800" height="400"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,800,400);c.fillStyle='#123';c.font='40px sans-serif';c.fillText('${req.url==='/one'?'BLUE HARBOR':'SILVER FIELD'}',70,180)</script>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}`;
const fact={text:'{"problems":[]}'};
let evidence:{images:number;text:string}[]=[];
const model=await startScriptedModel([
 {match:'USER REQUEST:',steps:[fact]},
 {match:'Resolve these internal evidence',steps:[{text:'图像结论被错误撤回。'}]},
 {match:'"lastReply"',steps:[{text:'{"status":"done","remaining":null}'}]},
 {match:TASK,steps:[
  {tool:{name:'navigate',args:{url:origin+'/one'}}},{tool:{name:'screenshot',args:{}}},
  {tool:{name:'navigate',args:{url:origin+'/two'}}},{tool:{name:'screenshot',args:{}}},{text:ANSWER}
 ]},
],undefined,payload=>{
 for(const m of payload.messages??[]){
  if(m.role!=='user')continue;
  const parts=Array.isArray(m.content)?m.content:[];
  const text=typeof m.content==='string'?m.content:parts.map(p=>p.text??'').join('');
  if(!text.includes('USER REQUEST:'))continue;
  const images=parts.filter(p=>p.type==='image_url').length;
  evidence.push({images,text});
  fact.text=JSON.stringify({problems:images===2?[]:[{kind:'insufficient_evidence',claim:ANSWER,source:null,quote:null,text:'核对请求缺少两张实际图片'}]});
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
 assert.equal(evidence[0]!.images,2,'checker must receive both actual screenshot images');
 assert.ok(evidence[0]!.text.includes(origin+'/one')&&evidence[0]!.text.includes(origin+'/two'),'both source labels preserved');
 const visible=String(await rp.evaluate(panel,`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.checkVisibility()).map(e=>e.innerText).join(' | ')`));
 assert.ok(visible.includes(ANSWER)&&!visible.includes('撤回')&&!visible.includes('无法确认'),'supported image answer remains visible');
 await rp.screenshot(panel,join(out,'answer.png'));
}catch(e){error=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{clearInterval(progress);await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2));await rp.close();await rp.remove();await model.close();site.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',error,out}));if(error)process.exitCode=1;
