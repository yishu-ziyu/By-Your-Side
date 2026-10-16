/** Negative control: a SCRIPTED model repeats an add and falsely claims success.
 * Real BYS Agent/AX/CDP, but NOT a live-model experiment or part of the 18 samples.
 * SIDEAGENT_ACCEPTANCE_DIST=... npx tsx scripts/gym/scripted-fault.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until, sleep } from '../acceptance/real-path/harness.mts';
import { startScriptedModel, type Step } from '../acceptance/real-path/scripted-model.mts';
import { modelStorageItems } from '../acceptance/real-path/inproc-config.mts';
import { startFixture, promptFor } from './fixture.mjs';
import { evaluate, claimFrom } from './evaluator.mjs';
import { installAudit } from './instrumentation.mts';
requireHeadless();
const out=join(REPO,'out/gym',`scripted-fault-${Date.now()}`);await mkdir(out,{recursive:true});
const mark='BYS-Gym故障探针',final='已完成全部待办任务，没有重复项。';
const add1={tool:{name:'fill',args:{target:'@0',value:'阅读论文',submit:true}}};
const add2={tool:{name:'fill',args:{target:'@0',value:'整理实验',submit:true}}};
const repeat={tool:{name:'fill',args:{target:'@0',value:'阅读论文',submit:true}}};
const complete={tool:{name:'click',args:{target:'@0'}}};
const steps:Step[]=[{tool:{name:'tabs',args:{action:'active'}}},{tool:{name:'snapshot',args:{}}},add1,add2,{tool:{name:'snapshot',args:{}}},complete,repeat,{text:final}];
const textOf=(value:unknown)=>typeof value==='string'?value:Array.isArray(value)?value.map(p=>p.text??'').join('\n'):'';
const model=await startScriptedModel([{match:mark,steps}],undefined,(payload:any)=>{
 if(!payload.tools?.length)return;
 const results=(payload.messages??[]).filter((m:any)=>m.role==='tool');
 const find=(text:string,label:string)=>text.split(/\\n|\n/).find(line=>line.includes(label))?.match(/\[ref=(\d+)\]/)?.[1];
 const input=results[1]&&find(textOf(results[1].content),'textbox');
 if(input)for(const step of [add1,add2,repeat])step.tool.args.target='@'+input;
 const checkbox=results[4]&&find(textOf(results[4].content),'checkbox');
 if(checkbox)complete.tool.args.target='@'+checkbox;
});
const site=await startFixture('todo',11),rp=await launchRealPath();
const result:Record<string,unknown>={model:'scripted negative control',status:'FAIL'};
try{
 const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
 await rp.cdp.send('Page.navigate',{url:site.origin},work);
 await until(async()=>await rp.evaluate(work,"!!document.querySelector('main')")||undefined,10000,'fixture');
 const observe=await installAudit(rp,work),panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify(modelStorageItems({providerId:'custom',modelId:'demo-model',baseUrl:model.baseUrl,credential:{type:'api_key',key:'local-scripted-no-secret'}}))}).then(()=>true)`);
 await until(async()=>await rp.evaluate(panel,"document.querySelector('#status-dot')?.classList.contains('on') && document.querySelector('#send-btn')?.disabled===false")||undefined,60000,'ready');
 await rp.click(panel,'#input');await rp.typeText(panel,`${mark}：${promptFor('todo')}`);await rp.pressEnter(panel);
 await until(async()=>await rp.evaluate(panel,`document.querySelector('#messages')?.innerText.includes(${JSON.stringify(final)}) && document.querySelector('#send-btn')?.disabled===false`)||undefined,90000,'false completion claim');
 await sleep(1000);
 const observed=await observe(),verdict=evaluate('todo',observed.state,site.effects,observed.audit);
 const trace=await rp.evaluate(panel,`new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-diagnostics');q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,t=db.transaction('trace-lines'),r=t.objectStore('trace-lines').getAll();r.onsuccess=()=>resolve(r.result.map(x=>JSON.parse(x.line)));t.oncomplete=()=>db.close()}})`);
 const tools=trace.filter((e:any)=>e.type==='tool_execution_end');
 assert.equal(observed.state.todos.length,3,'duplicate really exists');
 assert.equal(verdict.status,'failure');assert.ok(verdict.errors.includes('ITEM_COUNT'));
 assert.equal(claimFrom(final),'success');assert.ok(tools.length>=7);assert.ok(tools.every((e:any)=>!e.data.isError),'tools acknowledged the actions');
 result.status='PASS';Object.assign(result,{verdict,falseSuccessDetected:true,toolSuccessWithoutGoal:true,finalAnswer:final,state:observed.state,events:observed.audit,tools});
 await writeFile(join(out,'trace.jsonl'),trace.map((e:any)=>JSON.stringify(e)).join('\n')+'\n');
 await rp.screenshot(work,join(out,'duplicate.png'));await rp.screenshot(panel,join(out,'false-claim.png'));
}catch(error){result.error=String(error);process.exitCode=1}
finally{await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));await rp.close();await rp.remove();await site.close();await model.close()}
console.log(JSON.stringify({status:result.status,out,error:result.error}));
