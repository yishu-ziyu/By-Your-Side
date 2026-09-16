import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {loadConfig} from '../../agent/src/config.js';
import {runPageTranslation} from '../../agent/src/page-translation.js';
if(!process.argv.includes('--headless'))throw Error('Required --headless');
const out=resolve('docs/evals/20260916-page-translation-failure');await mkdir(out,{recursive:true});
const iso=await launchIsolatedExtension();
const session=await BrowserAgentSession.create(new ToolRpc(()=>{throw Error('Unexpected model browser request');}),{emit(){},setStatus(){}},{modelPattern:loadConfig().model});
const evidence:any={url:'https://asteriskmag.com/issues/15/why-we-like-things',batches:[]};
try{
 const target=await iso.newTarget(evidence.url);
 const tab=await until(async()=>{const tabs=await iso.swEval('chrome.tabs.query({})') as any[];return tabs.find(t=>t.url===evidence.url);},15000,'article tab');
 await until(async()=>await iso.evalIn(target,"document.readyState==='complete' && document.querySelector('main h1')?.textContent==='Why We Like Things'")||undefined,30000,'article ready');
 assert((await iso.tool('switch_tab',{tabId:tab.id})).ok);
 const call=async(params:any)=>{const r=await iso.tool('page_translation',{tabId:tab.id,...params});if(!r.ok)throw Object.assign(new Error(r.error),{executionFact:r.executionFact});return r.data;};
 const translate=async(blocks:any,language:string,signal:AbortSignal)=>{
  const metadata={blocks:blocks.length,segments:blocks.flatMap((b:any)=>b.segments).length,chars:JSON.stringify(blocks).length};
  console.log('batch',JSON.stringify(metadata));
  const started=Date.now();
  try{const result=await session.translatePageBatch(blocks,language,signal);evidence.batches.push({...metadata,ms:Date.now()-started,ok:true});return result;}
  catch(error){evidence.batches.push({...metadata,ms:Date.now()-started,ok:false,error:String(error)});throw error;}
 };
 if(process.argv.includes('--probe')){
  const started=await call({action:'begin',mode:'translated'});const batch=await call({action:'collect',document:started.document});
  evidence.collection={total:batch.remaining,unsupported:batch.unsupported};
  await translate(batch.blocks,batch.language,AbortSignal.timeout(65000));evidence.passed=true;
 }else{
  const start=Date.now();evidence.receipt=await runPageTranslation({action:'translate',tabId:tab.id,mode:'translated'},call,translate,AbortSignal.timeout(240000));
  assert.equal(evidence.receipt.remaining,0);assert.equal(evidence.receipt.unsupported,0);
  assert.match(await iso.evalIn(target,"document.querySelector('main h1').textContent"),/[\u4e00-\u9fff]/);
  assert.equal(await iso.evalIn(target,"document.querySelectorAll('[data-bys-translation]').length"),0);
  evidence.elapsedMs=Date.now()-start;evidence.passed=true;
  await iso.screenshot(target,resolve(out,'article-translated.png'));
 }
}finally{session.dispose();await iso.close();await writeFile(resolve(out,process.argv.includes('--probe')?'article-probe.json':'article-results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
