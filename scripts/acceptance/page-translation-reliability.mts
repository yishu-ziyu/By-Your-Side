/** Production injection errors, reversible typography, and no repeated model work. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
if(!process.argv.includes('--headless'))throw Error('Required: --headless');
const out=resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6) ?? 'docs/evals/20260917-page-translation-reliability');await mkdir(out,{recursive:true});
const iso=await launchIsolatedExtension({fixtureHtml:`<!doctype html><meta charset="utf-8"><style>body{font:20px Arial}a{font-family:Arial}</style><main><h1>Read with care</h1><p style="color: blue; font-family: Georgia !important;">Read <a href="#source">the source</a>.</p></main>`});
try{
 const target=await iso.newTarget(iso.fixtureOrigin+'/article');
 const tab=await until(async()=>(await iso.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===iso.fixtureOrigin+'/article'),5000,'tab');
 const page=(js:string)=>iso.evalIn(target,js);
 await until(async()=>await page('document.readyState==="complete"')||undefined,5000,'document');
 assert((await iso.tool('switch_tab',{tabId:tab.id})).ok);
 const raw=(p:any)=>iso.tool('page_translation',{tabId:tab.id,...p});
 const call=async(p:any)=>{const r=await raw(p);assert(r.ok,JSON.stringify(r));return r.data;};
 const missing=await raw({action:'display',mode:'translated'});
 assert.equal(missing.ok,false);assert.equal(missing.executionFact,'not_executed');assert.match(missing.error,/还没有译文/);
 const original=await page('document.querySelector("main").innerHTML');
 let r=await call({action:'begin',mode:'translated'});
 const stale=await raw({action:'collect',document:'stale'});assert.equal(stale.executionFact,'not_executed');assert.match(stale.error,/网页已变化/);
 r=await call({action:'collect',document:r.document});
 const dict:Record<string,string>={'Read with care':'认真阅读','Read ':'阅读 ','the source':'原文','.':'。'};
 await call({action:'apply',document:r.document,translations:r.blocks.flatMap((b:any)=>b.segments.map((s:any)=>({id:s.id,text:dict[s.text]})))});
 await call({action:'display',fontFamily:'songti'});
 assert.match(await page('getComputedStyle(document.querySelector("a")).fontFamily'),/Songti SC/);
 assert.match(await page('getComputedStyle(document.querySelector("p")).fontFamily'),/Songti SC/);
 await call({action:'display',mode:'bilingual'});
 assert.match(await page('getComputedStyle(document.querySelector("p")).fontFamily'),/Georgia/);
 assert.match(await page('getComputedStyle(document.querySelector("p [data-bys-translation]")).fontFamily'),/Songti SC/);
 assert.match(await page('getComputedStyle(document.querySelector("p [data-bys-translation] a")).fontFamily'),/Songti SC/);
 assert.equal((await call({action:'collect',document:r.document})).blocks.length,0);
 await call({action:'display',mode:'translated',fontSize:24,fontFamily:'original'});
 assert.match(await page('getComputedStyle(document.querySelector("a")).fontFamily'),/Arial/);
 await call({action:'display',fontFamily:'songti'});
 await iso.screenshot(target,out+'/songti.png');
 await call({action:'restore'});assert.equal(await page('document.querySelector("main").innerHTML'),original);
 // Repeat typography after the website changes inline-style presence.
 for (const initial of [false,true]) {
  for (const fontSize of [undefined,24]) {
   await page(`document.querySelector('h1').${initial ? "setAttribute('style','')" : "removeAttribute('style')"}`);
   let cycle=await call({action:'begin',mode:'translated'});
   cycle=await call({action:'collect',document:cycle.document});
   await call({action:'apply',document:cycle.document,translations:cycle.blocks.flatMap((b:any)=>b.segments.map((s:any)=>({id:s.id,text:dict[s.text]})))});
   await call({action:'display',fontFamily:'songti',fontSize,mode:'translated'});
   assert.match(await page('getComputedStyle(document.querySelector("h1")).fontFamily'),/Songti SC/);
   await call({action:'display',fontFamily:'original',...(fontSize ? {mode:'bilingual'} : {})});
   await page(`document.querySelector('h1').${initial ? "removeAttribute('style')" : "setAttribute('style','')"}`);
   const before=await page('document.querySelector("main").innerHTML');
   await call({action:'display',fontFamily:'songti',fontSize,mode:'translated'});
   assert.match(await page('getComputedStyle(document.querySelector("h1")).fontFamily'),/Songti SC/);
   await call({action:'display',fontFamily:'original',...(fontSize ? {mode:'bilingual'} : {})});
   assert.equal(await page('document.querySelector("main").innerHTML'),before,`style presence ${initial} -> ${!initial}, fontSize=${fontSize}`);
   await call({action:'restore'});
  }
 }
 const doomed=await iso.newTarget(iso.fixtureOrigin+'/closed');
 const doomedTab=await until(async()=>(await iso.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===iso.fixtureOrigin+'/closed'),5000,'doomed tab');
 await iso.closeTarget(doomed);
 await until(async()=>!(await iso.swEval('chrome.tabs.query({})') as any[]).some(t=>t.id===doomedTab.id)||undefined,5000,'closed tab');
 const closed=await iso.tool('page_translation',{action:'begin',tabId:doomedTab.id});
 assert.equal(closed.ok,false);assert.equal(closed.executionFact,'not_executed');
 await call({action:'begin',mode:'translated'});
 await call({action:'restore'});
 await writeFile(out+'/browser-results.json',JSON.stringify({passed:true,missing,stale,font:true,restore:true,repeatedStyleCycles:4,closed},null,2));
 console.log('PASS: exact page errors, safe failure recovery, Songti, bilingual, original and exact restore');
}finally{await iso.close();}
