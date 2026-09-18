/** Isolated production manager/model versus experimental Jev display routing. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {loadConfig} from '../../agent/src/config.js';
import {launchIsolatedExtension,until,sleep} from '../acceptance/isolated-extension.mts';
import {routeDisplay} from './typesafe-display-router.mts';
if(!process.argv.includes('--headless'))throw Error('Required --headless');
const out=resolve('out/experiments',`typesafe-display-${Date.now()}`);await mkdir(out,{recursive:true});
const key=(await readFile('.env.typesafe.local','utf8')).split('\n').find(s=>s.startsWith('TYPESAFE_API_KEY='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');assert(key);
const model=loadConfig().model;assert.equal(model,'opencode-go/deepseek-flash','Reassess comparison if configured model changed');
const results:any[]=[],routing:any[]=[];let baselineCount=0;let finished=false;const verification=process.argv.includes('--verify');const songtiOnly=process.argv.includes('--songti-only');const deadline=Date.now()+480000;let manager:ConversationManager|undefined;
const iso=await launchIsolatedExtension({fixtureHtml:'<!doctype html><meta charset="utf-8"><title>Reading fixture</title><style>body{font:20px Arial}</style><main><p id="text">Read with care.</p></main>'});
try{
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');
 const tab:any=await until(async()=>(await iso.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===iso.fixtureOrigin+'/article'),5000,'tab');
 await until(async()=>await iso.evalIn(target,'document.readyState==="complete"')||undefined,5000,'ready');
 assert((await iso.tool('switch_tab',{tabId:tab.id},'main')).ok);
 const page=(s:string)=>iso.evalIn(target,s);
 const call=async(params:any)=>{const r=await iso.tool('page_translation',{tabId:tab.id,...params},'main');assert(r.ok,r.error);return r.data;};
 let r=await call({action:'begin',mode:'translated'});r=await call({action:'collect',document:r.document});
 await call({action:'apply',document:r.document,translations:r.blocks.flatMap((b:any)=>b.segments.map((s:any)=>({id:s.id,text:'认真阅读。'})))});
 const observe=()=>page(`(()=>{const p=document.querySelector('main p'),t=p.querySelector('[data-bys-translation]');return {mode:t?'bilingual':'translated',font:getComputedStyle(t||p).fontFamily,text:p.textContent};})()`);
 const originalFont=await page('getComputedStyle(document.querySelector("main p")).fontFamily');
 const cases=[
  {id:'songti',text:'把已有译文的字体改成宋体。',initial:{mode:'translated',fontFamily:'original'},expected:{fontFamily:'songti'}},
  {id:'original',text:'把已有译文的字体恢复成网站原来的字体，保留译文。',initial:{mode:'translated',fontFamily:'songti'},expected:{fontFamily:'original'}},
  {id:'bilingual',text:'显示原文和译文对照。',initial:{mode:'translated',fontFamily:'original'},expected:{mode:'bilingual'}},
  {id:'translated',text:verification?'已有译文我不要双语，只要译文。':'只显示译文。',initial:{mode:'bilingual',fontFamily:'original'},expected:{mode:'translated'}},
 ];
 const correct=(s:any,c:any)=>s.mode===(c.expected.mode??c.initial.mode)&&((c.expected.fontFamily??c.initial.fontFamily)==='songti'?/Songti SC/.test(s.font):s.font===originalFont)&&(s.mode==='translated'?s.text.trim()==='认真阅读。':s.text.includes('Read with care.')&&s.text.includes('认真阅读。'));
 async function watchDOM(completed:()=>Promise<boolean>,started:number,signal:AbortSignal){while(!signal.aborted){if(await completed())return performance.now()-started;await sleep(75);}return undefined;}
 async function baseline(text:string,row:any,completed:()=>Promise<boolean>){
  if(++baselineCount>10)throw Error("Baseline task budget exhausted");
  const store=new ConversationStore(join(out,`session-${results.length}-${Date.now()}`));
  const events:any[]=[];const jobs=new Set<Promise<unknown>>();let turns=0;
  manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,model,{sessionManager:store.sessionManager(id),mode:summary?.mode}),message=>{
   events.push({at:Date.now(),message});
   if(message.type==='agent_event'&&message.event.kind==='turn_start'&&++turns>(songtiOnly?8:4))manager?.get('default')?.runtime.session.abort();
   if(message.type==='tool_call'){
    const job=(async()=>{
     const forbidden=!verification&&message.name==='page_translation'&&message.params.action!=='display';
     const answer=forbidden?{ok:false,error:'Benchmark display-only request cannot generate translations',executionFact:'not_executed'}:await iso.tool(message.name,message.params,message.sessionId??'main');
     await manager!.handleMessage({...answer,type:'tool_result',conversationId:message.conversationId,id:message.id} as any);
    })().catch(async()=>{row.bridgeError=true;await manager?.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:false,error:'Benchmark bridge failed',executionFact:'unknown'} as any);manager?.get('default')?.runtime.session.abort();});jobs.add(job);void job.finally(()=>jobs.delete(job));
   }
  },store);
  try{
   const entry=await manager.ensureDefault();assert(entry.runtime.session.available);row.model=entry.runtime.session.modelName();
   const begin=performance.now();const watching=new AbortController();const seen=watchDOM(completed,row.requestStarted??begin,watching.signal);
   await manager.handleMessage({type:'user_message',conversationId:'default',text,context:{tabId:tab.id,url:tab.url,title:tab.title}} as any);
   const end=performance.now()+45000;
   while(performance.now()<end){
    if(events.some(e=>e.message?.event?.kind==='agent_end')&&!entry.runtime.session.isStreaming())break;
    await sleep(75);
   }
   watching.abort();row.domMs=await seen;row.totalMs=performance.now()-begin;row.modelTurns=turns;row.timedOut=entry.runtime.session.isStreaming();
   if(row.timedOut)entry.runtime.session.abort();
   row.calls=events.filter(e=>e.message.type==='tool_call').map(e=>({name:e.message.name,params:e.message.params}));
   row.delivered=events.some(e=>e.message?.event?.kind==='user_delivery'&&e.message.event.delivery.kind==='finding');
   await writeFile(join(out,`trace-${results.length}.json`),JSON.stringify(events,null,2));
  }finally{manager.get('default')?.runtime.session.abort();await Promise.allSettled(jobs);manager.dispose();manager=undefined;}
 }
 for(let repeat=0;repeat<2;repeat++)for(const c of cases.filter(c=>songtiOnly?c.id==='songti':!verification||['songti','translated'].includes(c.id))){
  if(Date.now()>deadline)throw Error('Global benchmark deadline');
  for(const method of repeat===0?['baseline','jev']:['jev','baseline']){
   await call({action:'display',...c.initial});assert(!(await correct(await observe(),c)),'Must start from opposite state');
   const row:any={id:c.id,repeat,method,text:c.text};let routeWatch:AbortController|undefined;
   try{
    if(method==='baseline')await baseline(c.text,row,async()=>correct(await observe(),c));
    else{
     const begin=performance.now();row.requestStarted=begin;const watching=new AbortController();routeWatch=watching;const seen=watchDOM(async()=>correct(await observe(),c),begin,watching.signal);const decision=await routeDisplay(c.text,true,key);row.decision=decision;
     if(decision.params){await call(decision.params);row.domMs=await Promise.race([seen,sleep(5000).then(()=>undefined)]);row.modelTurns=0;row.exactParams=JSON.stringify(decision.params)===JSON.stringify({action:'display',...c.expected});}
     else{row.fallback=true;await baseline(c.text,row,async()=>correct(await observe(),c));}
     watching.abort();await seen;row.totalMs=performance.now()-begin;
    }
    row.observed=await observe();row.correct=correct(row.observed,c);row.completed=method==='baseline'||row.fallback?row.correct&&row.delivered&&!row.timedOut:row.correct;
    const check=await call({action:'collect',document:r.document});row.noRetranslation=check.blocks.length===0&&!row.calls?.some((x:any)=>x.name==='page_translation'&&x.params.action!=='display');
   }catch(error){row.error=error instanceof Error?error.message:String(error);row.correct=false;}finally{routeWatch?.abort();}
   results.push(row);await writeFile(join(out,'results.json'),JSON.stringify({model,results,routing},null,2));
   console.log(JSON.stringify({id:c.id,repeat,method,correct:row.correct,domMs:row.domMs,fallback:row.fallback,error:row.error}));
  }
 }
 if(!songtiOnly)for(const text of ['不要改成宋体。',verification?'我只是询问你是否支持宋体，不要实际修改。':'你能把字体改成宋体吗？','他说“只显示译文”，这是什么意思？','改成宋体，然后把正文总结一下。','重新翻译一遍，只保留译文。','恢复原文。','改成楷体。','字号改成24。']){
  const before=await observe();const decision=await routeDisplay(text,true,key);
  // Negative cases never execute the returned candidate; an unsafe acceptance is recorded as a failure.
  routing.push({text,decision,correct:decision.params===null,unchanged:JSON.stringify(await observe())===JSON.stringify(before)});
 }
 const missing=await routeDisplay('改成宋体',false,key);routing.push({text:'无译文时改成宋体',decision:missing,correct:missing.params===null&&missing.reason==='no_translation'});
 if(verification&&!songtiOnly){
  const c=cases[0];await call({action:'display',...c.initial});const row:any={id:'timeout-fallback',method:'jev',text:c.text};
  const started=performance.now();row.requestStarted=started;
  const stalledFetch=((_url:any,init:any)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('injected timeout')),{once:true}))) as typeof fetch;
  row.decision=await routeDisplay(c.text,true,key,undefined,stalledFetch);assert.equal(row.decision.params,null);row.fallback=true;
  await baseline(c.text,row,async()=>correct(await observe(),c));row.observed=await observe();row.correct=correct(row.observed,c);row.completed=row.correct&&row.delivered&&!row.timedOut;row.noRetranslation=!row.calls.some((x:any)=>x.name==='page_translation'&&x.params.action!=='display');row.pathToDeliveryMs=performance.now()-started;results.push(row);
 }
 const passed=results.every(r=>r.correct&&r.completed&&r.noRetranslation&&!r.error&&!r.bridgeError&&!r.timedOut&&r.exactParams!==false)&&routing.every(r=>r.correct);
 if(!passed)process.exitCode=1;
 await iso.screenshot(target,join(out,'final.png'));finished=true;
}finally{
 manager?.dispose();await iso.close();
 await writeFile(join(out,'results.json'),JSON.stringify({model,verification,passed:finished&&results.length>0&&results.every(r=>r.correct&&r.completed&&r.noRetranslation&&!r.error&&!r.bridgeError&&!r.timedOut&&r.exactParams!==false)&&routing.every(r=>r.correct),results,routing,scope:'Isolated production manager and extension tool bridge; experimental direct path; not panel/voice or production integration'},null,2));
 console.log(JSON.stringify({out,cases:results.length,routing:routing.length}));
}
