/** Real extension + >10 MB screenshot through MiniMax's actual protocol. --live checks the real model; default uses a provider stub enforcing the observed byte limit. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
import {loadModelPlan,modelStorageItems} from './inproc-config.mts';
requireHeadless();const live=process.argv.includes('--live');
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-large-image-delivery`);await mkdir(out,{recursive:true});
const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<title>图片传输</title><style>body{margin:0}</style><canvas width="2400" height="1800"></canvas><script>const c=document.querySelector('canvas').getContext('2d'),p=c.createImageData(2400,1800);let n=482;for(let i=0;i<p.data.length;i+=4){n=(Math.imul(n,1664525)+1013904223)>>>0;p.data[i]=n>>>24;p.data[i+1]=(n>>>16)&255;p.data[i+2]=(n>>>8)&255;p.data[i+3]=255}c.putImageData(p,0,0);c.fillStyle='#a12';c.fillRect(30,30,900,150);c.fillStyle='white';c.font='bold 70px sans-serif';c.fillText('IMAGE-482',60,135)</script>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${siteAddress(site).port}/`;
const checker=await startScriptedModel([{match:'"requests"',steps:[{text:'{"scope":"local"}'}]},{match:'',steps:[{text:'{"status":"done","problems":[],"remaining":null}'}]}]);
const rp=await launchRealPath();let panel='',failure='';const observed:Array<{mime:string;bytes:number;width?:number;height?:number}>=[];
const liveImages:string[]=[];
const progress=setInterval(()=>console.log(JSON.stringify({live,imageRequests:observed.length})),30000);
try{
 panel=await rp.attach(await rp.openSidePanel());
 const main=live?modelStorageItems(await loadModelPlan('minimax-cn/MiniMax-M3')):{inproc_model_config:{provider:'minimax-cn',modelId:'MiniMax-M3'},'inproc_cred:minimax-cn':{type:'api_key',key:'fixture'}};
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({...main,inproc_fast_model_config:{provider:'custom',modelId:'fixture',baseUrl:checker.baseUrl},'inproc_cred:custom':{type:'api_key',key:'fixture'}})}).then(()=>true)`);
 const host=await until(async()=>(await rp.targets()).find(t=>t.url.endsWith('/inproc.html')),30000,'host');const hs=await rp.attach(host.targetId);
 rp.cdp.onEvent('Fetch.requestPaused',(e:any)=>{if(e.sessionId!==hs)return;void(async()=>{
  const payload=JSON.parse(e.params.request.postData??'{}');console.log(JSON.stringify({phase:'provider-request',messages:payload.messages?.length??0}));const all:any[]=[];
  const scan=(parts:any[])=>{for(const p of parts){if(p.type==='image')all.push(p);if(Array.isArray(p.content))scan(p.content);}};for(const m of payload.messages??[])if(Array.isArray(m.content))scan(m.content);
  for(const image of all){const data=image.source.data;const dims=await rp.evaluate(hs,`(async()=>{const b=await createImageBitmap(await (await fetch(${JSON.stringify('data:'+image.source.media_type+';base64,'+data)})).blob());const d={width:b.width,height:b.height};b.close();return d})()`);observed.push({mime:image.source.media_type,bytes:Buffer.from(data,'base64').length,...dims as object});}
  if(live){await rp.cdp.send('Fetch.continueRequest',{requestId:e.params.requestId},hs);return;}
  if(observed.some(x=>x.bytes>10485760)){await rp.cdp.send('Fetch.fulfillRequest',{requestId:e.params.requestId,responseCode:400,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'media exceeds size limit: max 10485760 bytes (2013)'}})).toString('base64')},hs);return;}
  const hasImage=all.length>0;const block=hasImage?{type:'text',text:''}:{type:'tool_use',id:'shot1',name:'screenshot',input:{}};
  const events=[{type:'message_start',message:{id:'m1',type:'message',role:'assistant',model:'MiniMax-M3',content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}},{type:'content_block_start',index:0,content_block:block},{type:'content_block_delta',index:0,delta:hasImage?{type:'text_delta',text:'图片里的核对码是 IMAGE-482。'}:{type:'input_json_delta',partial_json:'{"fullPage":true,"scale":"css"}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:hasImage?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:30}},{type:'message_stop'}];
  await rp.cdp.send('Fetch.fulfillRequest',{requestId:e.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/event-stream'}],body:Buffer.from(events.map(x=>`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join('')).toString('base64')},hs);
 })().catch(err=>{failure=String(err);console.error(failure);});});
 if(!live) await rp.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*api.minimaxi.com/anthropic/*',requestStage:'Request'}]},hs);
 else {
  rp.cdp.onEvent('Network.requestWillBeSent',(e:any)=>{
   if(e.sessionId!==hs||e.params.request.method!=='POST'||!e.params.request.url.includes('api.minimaxi.com/anthropic/'))return;
   const payload=JSON.parse(e.params.request.postData??'{}');
   const scan=(parts:any[])=>{for(const p of parts){if(p.type==='image'&&p.source?.type==='base64'){observed.push({mime:p.source.media_type,bytes:Buffer.from(p.source.data,'base64').length});liveImages.push('data:'+p.source.media_type+';base64,'+p.source.data);}if(Array.isArray(p.content))scan(p.content);}};
   for(const m of payload.messages??[])if(Array.isArray(m.content))scan(m.content);
  });
  await rp.cdp.send('Network.enable',{maxPostDataSize:32000000},hs);
 }

 await rp.evaluate(panel,`chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.click(panel,'#input');await rp.typeText(panel,'拍一张 fullPage:true、scale:css 的截图，读出红框里的核对码。');await rp.pressEnter(panel);
 await until(async()=>{if(failure)throw Error(failure);const state=await rp.evaluate(panel,`({answer:[...document.querySelectorAll('.msg.assistant')].map(x=>x.innerText).join(' '),error:document.querySelector('.error-card, .msg.error')?.innerText})`) as {answer:string;error?:string};if(state.error)throw Error(state.error);return state.answer.includes('IMAGE-482');},live?150000:60000,'large image answer');
 if(live&&liveImages[0]){const dims=await rp.evaluate(hs,`(async()=>{const b=await createImageBitmap(await (await fetch(${JSON.stringify(liveImages[0])})).blob());const d={width:b.width,height:b.height};b.close();return d})()`);Object.assign(observed[0]!,dims);}
 assert.ok(observed.length>0,'image sent');assert.ok(observed.every(x=>x.mime==='image/webp'&&x.bytes<10485760),'compressed image within actual provider limit');assert.ok(observed.some(x=>x.width===2400&&x.height>=1800),'pixel dimensions retained');
 await rp.screenshot(panel,join(out,'answer.png'));
}catch(e){failure=String(e);if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{clearInterval(progress);await writeFile(join(out,'result.json'),JSON.stringify({status:failure?'FAIL':'PASS',live,failure,observed},null,2));await rp.close();await rp.remove();await checker.close();site.close();}
console.log(JSON.stringify({status:failure?'FAIL':'PASS',failure,observed,out}));if(failure)process.exitCode=1;
