/**
 * Real extension: when the model provider's content moderation blocks the answer (MiniMax "output new_sensitive (1027)"),
 * the error card says so and offers only "换一个模型" — retrying the same model would be blocked again. A plain
 * unexplained failure still gets the generic card with "重试".
 *   npx tsx scripts/acceptance/real-path/moderation-error-card.mts --headless
 * The model is scripted (it returns the provider's error body), so this proves the panel layer.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-moderation-error-card`);
await mkdir(out,{recursive:true});
const CASES=[
 {id:'moderation',body:JSON.stringify({type:'error',error:{type:'api_error',message:'output new_sensitive (1027)'}}),title:'模型的内容审核拦下了这次回答',retry:false},
 {id:'other',body:JSON.stringify({error:{message:'something odd happened'}}),title:'模型这次没有给出回答',retry:true},
];
const results:Array<{id:string;status:'pass'|'fail';card?:unknown;error?:string}>=[];

for(const item of CASES){
 const task=`审核卡验收${item.id}：历史上的今天发生了什么。`;
 const model=await startScriptedModel([{match:task,steps:[{status:400,body:item.body}]}]);
 const rp=await launchRealPath();let panel='',card:{title:string;buttons:string[]}|undefined;
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  card=await until(async()=>(await rp.evaluate(panel,`(()=>{const c=[...document.querySelectorAll('.error-card')].at(-1);return c?{title:c.querySelector('strong')?.innerText??'',buttons:[...c.querySelectorAll('.error-card-actions button')].map(b=>b.innerText.trim())}:null})()`)) as typeof card??undefined,60000,'error card');
  await rp.screenshot(panel,join(out,`${item.id}-panel.png`));
  assert.equal(card!.title,item.title,`${item.id}: card title`);
  assert.ok(card!.buttons.some(b=>b.startsWith('换一个模型')),`${item.id}: offers another model`);
  assert.equal(card!.buttons.includes('重试'),item.retry,`${item.id}: retry button ${item.retry?'shown':'hidden'}`);
  results.push({id:item.id,status:'pass',card});
 }catch(e){
  results.push({id:item.id,status:'fail',card,error:String(e).split('\n')[0]});
  if(panel)await rp.screenshot(panel,join(out,`${item.id}-failure.png`)).catch(()=>{});
 }finally{await rp.close();await rp.remove();await model.close();}
 console.log(JSON.stringify(results.at(-1)));
}
const failed=results.filter(r=>r.status==='fail');
await writeFile(join(out,'result.json'),JSON.stringify({status:failed.length?'fail':'pass',results,dependency:'real isolated extension; scripted model returning the provider error body'},null,2));
console.log(JSON.stringify({status:failed.length?'fail':'pass',passed:results.length-failed.length,total:results.length,out}));
if(failed.length)process.exitCode=1;
