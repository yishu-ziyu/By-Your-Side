/**
 * Real extension and page: copying a sentence or paragraph range writes exactly that text, and a range that is
 * out of bounds or disagrees with what the user asked for leaves the draft untouched.
 *   npx tsx scripts/acceptance/real-path/copy-range.mts --headless [--only=A,G]
 * The model is scripted (its fill arguments and the copy-intent judgment are fixed per case), so this proves the
 * browser and host layer, not that a real model picks the right range.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-copy-range`);
await mkdir(out,{recursive:true});
const ORIGINAL='ORIGINAL DRAFT';
const P1='First sentence alpha. Second sentence beta. Third sentence gamma.';
const P2='Closing paragraph one. Closing paragraph two.';
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>Copy range</title><main><div id="note"><p>${P1}</p><p>${P2}</p></div><textarea id="draft">${ORIGINAL}</textarea></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}/`;

type Range={unit:'sentence'|'paragraph';first:number;count:number};
type Case={id:string;ask:string;intent:Range|null;quote?:string;modelRange?:Range;expect:string;refused?:RegExp};
const CASES:Case[]=[
 {id:'A',ask:'把 Note 框第一句原文复制到草稿框。',intent:{unit:'sentence',first:1,count:1},quote:'第一句',modelRange:{unit:'sentence',first:1,count:1},expect:'First sentence alpha.'},
 {id:'B',ask:'把 Note 框最后一句原文复制到草稿框。',intent:{unit:'sentence',first:-1,count:1},quote:'最后一句',modelRange:{unit:'sentence',first:-1,count:1},expect:'Closing paragraph two.'},
 {id:'C',ask:'把 Note 框第二段原文复制到草稿框。',intent:{unit:'paragraph',first:2,count:1},quote:'第二段',modelRange:{unit:'paragraph',first:2,count:1},expect:P2},
 {id:'D',ask:'把 Note 框全部原文复制到草稿框。',intent:null,expect:`${P1}\n\n${P2}`},
 {id:'E',ask:'把 Note 框第九句原文复制到草稿框。',intent:{unit:'sentence',first:9,count:1},quote:'第九句',modelRange:{unit:'sentence',first:9,count:1},expect:ORIGINAL,refused:/越界/},
 {id:'F',ask:'把 Note 框第一句原文复制到草稿框。',intent:{unit:'sentence',first:1,count:1},quote:'第一句',modelRange:{unit:'sentence',first:2,count:1},expect:ORIGINAL,refused:/不一致/},
 // 原来的回归：只要第一句，模型却整块复制。
 {id:'G',ask:'把 Note 框第一句原文复制到草稿框。',intent:{unit:'sentence',first:1,count:1},quote:'第一句',expect:ORIGINAL,refused:/用户要求复制 1 句/},
];
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
const results:Array<{id:string;status:'pass'|'fail';draft?:string;toolResult?:string;error?:string}>=[];

for(const item of CASES.filter(c=>!only||only.includes(c.id))){
 const tag=`范围验收${item.id}`,task=`${tag}：${item.ask}`;
 let toolResult='';
 const fill={target:'#draft',from:{target:'#note',...(item.modelRange?{range:item.modelRange}:{})}};
 const model=await startScriptedModel([
  {match:`"copyRequest":["${tag}`,steps:[{text:JSON.stringify({mode:'preserve',permission:'',range:item.intent,rangeQuote:item.intent?item.quote:''})}]},
  {match:'"lastReply"',steps:[{text:JSON.stringify({status:'done',remaining:'',items:[{text:'复制到草稿框',done:true}]})}]},
  {match:task,steps:[{tool:{name:'navigate',args:{url:origin}}},{tool:{name:'fill',args:fill}},{text:`${tag}完成。`}]},
 ],undefined,payload=>{
  // 消息内容可能是字符串，也可能是分段数组。
  const text=(content:unknown)=>typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part?.text==='string'?part.text:'').join(''):'';
  const messages=payload.messages??[];
  const tool=messages.filter(m=>m.role==='tool').at(-1);
  if(payload.tools?.length&&tool&&messages.some(m=>m.role==='user'&&text(m.content).includes(task)))toolResult=text(tool.content);
 });
 const rp=await launchRealPath();let panel='',page='';
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  page=await rp.attach((await until(async()=>(await rp.targets()).find(t=>t.url===origin),20000,'practice page')).targetId);
  await until(()=>rp.evaluate(panel,`document.body.innerText.includes(${JSON.stringify(`${tag}完成`)})`),60000,'scripted run finished');
  const draft=String(await rp.evaluate(page,`document.querySelector('#draft').value`));
  assert.equal(draft,item.expect,`${item.id}: draft`);
  if(item.refused)assert.match(toolResult,item.refused,`${item.id}: fill refused with a reason`);
  results.push({id:item.id,status:'pass',draft,toolResult:toolResult.slice(0,300)});
  await rp.screenshot(page,join(out,`${item.id}-page.png`));
 }catch(e){
  const draft=page?String(await rp.evaluate(page,`document.querySelector('#draft')?.value`).catch(()=>'')):undefined;
  results.push({id:item.id,status:'fail',draft,toolResult:toolResult.slice(0,300),error:String(e).split('\n')[0]});
  if(panel)await rp.screenshot(panel,join(out,`${item.id}-failure.png`)).catch(()=>{});
 }finally{await rp.close();await rp.remove();await model.close();}
 console.log(JSON.stringify(results.at(-1)));
}
await new Promise<void>(r=>site.close(()=>r()));
const failed=results.filter(r=>r.status==='fail');
await writeFile(join(out,'result.json'),JSON.stringify({status:failed.length?'fail':'pass',results,dependency:'real isolated extension and page; scripted model and copy-intent judgment'},null,2));
console.log(JSON.stringify({status:failed.length?'fail':'pass',passed:results.length-failed.length,total:results.length,out}));
if(failed.length)process.exitCode=1;
