/** Negative control: a SCRIPTED model repeats an add and falsely claims success.
 * --parallel-fill instead checks native fill compatibility provenance.
 * Real BYS Agent/AX/CDP, but NOT a live-model experiment or part of the 18 samples.
 * SIDEAGENT_ACCEPTANCE_DIST=... npx tsx scripts/gym/scripted-fault.mts --headless
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until, sleep } from '../acceptance/real-path/harness.mts';
import { startScriptedModel, type Step } from '../acceptance/real-path/scripted-model.mts';
import { modelStorageItems } from '../acceptance/real-path/inproc-config.mts';
import { startFixture, requestFor } from './fixture.mjs';
import { evaluate, claimFrom } from './evaluator.mjs';
import { installAudit, installBudget } from './instrumentation.mts';
requireHeadless();
const out=join(REPO,'out/gym',`scripted-fault-${Date.now()}`);await mkdir(out,{recursive:true});
const form=process.argv.includes('--parallel-fill');
const mark='BYS-Gym故障探针',final=form?'已填写姓名、邮箱、备注，未提交表单。':'已完成全部待办任务，没有重复项。';
const fields=[['姓名','林晓'],['邮箱','lin.xiao@example.com'],['备注','请保留草稿']].map(([label,value])=>({label,tool:{name:'fill',args:{target:'@0',value}}}));
const add1={tool:{name:'fill',args:{target:'@0',value:'阅读论文',submit:true}}};
const add2={tool:{name:'fill',args:{target:'@0',value:'整理实验',submit:true}}};
const repeat={tool:{name:'fill',args:{target:'@0',value:'阅读论文',submit:true}}};
const complete={tool:{name:'click',args:{target:'@0'}}};
const todoSteps:Step[]=[{tool:{name:'tabs',args:{action:'active'}}},{tool:{name:'snapshot',args:{}}},add1,add2,{tool:{name:'snapshot',args:{}}},complete,repeat,{text:final}];
const steps:Step[]=form?[{tool:{name:'tabs',args:{action:'active'}}},{tool:{name:'snapshot',args:{}}},{tools:fields.map(x=>x.tool)},{text:final},{text:final},{text:final}]:todoSteps;
const textOf=(value:unknown)=>typeof value==='string'?value:Array.isArray(value)?value.map(p=>p.text??'').join('\n'):'';
const model=await startScriptedModel([{match:mark,steps}],undefined,(payload:any)=>{
 if(!payload.tools?.length)return;
 const results=(payload.messages??[]).filter((m:any)=>m.role==='tool');
 const find=(text:string,label:string)=>text.split(/\\n|\n/).find(line=>line.includes(label))?.match(/\[ref=(\d+)\]/)?.[1];
 if(form&&results[1])for(const field of fields){const line=textOf(results[1].content).split(/\\n|\n/).find(line=>line.includes('textbox')&&line.includes(field.label));const ref=line?.match(/\[ref=(\d+)\]/)?.[1];if(ref)field.tool.args.target='@'+ref;}
 const input=results[1]&&find(textOf(results[1].content),'textbox');
 if(input)for(const step of [add1,add2,repeat])step.tool.args.target='@'+input;
 const checkbox=results[4]&&find(textOf(results[4].content),'checkbox');
 if(checkbox)complete.tool.args.target='@'+checkbox;
});
const site=await startFixture(form?'form':'todo',11),rp=await launchRealPath();
const result:Record<string,unknown>={model:'scripted negative control',status:'FAIL'};
try{
 const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
 await rp.cdp.send('Page.navigate',{url:site.origin},work);
 await until(async()=>await rp.evaluate(work,"!!document.querySelector('main')")||undefined,10000,'fixture');
 const observe=await installAudit(rp,work),panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify(modelStorageItems({providerId:'custom',modelId:'demo-model',baseUrl:model.baseUrl,credential:{type:'api_key',key:'local-scripted-no-secret'}}))}).then(()=>true)`);
 await until(async()=>await rp.evaluate(panel,"document.querySelector('#status-dot')?.classList.contains('on') && document.querySelector('#send-btn')?.disabled===false")||undefined,60000,'ready');
 const budget=await installBudget(rp,Date.now()+120000,1200);
 await rp.click(panel,'#input');await rp.typeText(panel,`${mark}：${requestFor(form?'form':'todo').text}`);await rp.pressEnter(panel);
 await until(async()=>await rp.evaluate(panel,`document.querySelector('#messages')?.innerText.includes(${JSON.stringify(final)}) && document.querySelector('#send-btn')?.disabled===false`)||undefined,90000,'false completion claim');
 await sleep(1000);
 const observed=await observe(),commands=await budget.read(),verdict=evaluate(form?'form':'todo',observed.state,site.effects,observed.audit,null,commands.log);
 const trace=await rp.evaluate(panel,`new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-diagnostics');q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,t=db.transaction('trace-lines'),r=t.objectStore('trace-lines').getAll();r.onsuccess=()=>resolve(r.result.map(x=>JSON.parse(x.line)));t.oncomplete=()=>db.close()}})`);
 const tools=trace.filter((e:any)=>e.type==='tool_execution_end');
 if(form){
  assert.ok(commands.log.some((c:any)=>c.inputAdapter==='fill'&&c.name),'native compatibility adapter really ran');
  assert.equal(verdict.status,'success','field-bound native fill accepted with independent state');
 }else{
  assert.equal(observed.state.todos.length,3,'duplicate really exists');
  assert.equal(verdict.status,'failure');assert.ok(verdict.errors.includes('ITEM_COUNT'));
  assert.equal(claimFrom(final),'success');assert.ok(tools.length>=7);assert.ok(tools.every((e:any)=>!e.data.isError),'tools acknowledged the actions');
 }
 result.status='PASS';Object.assign(result,{mode:form?'native-fill-provenance':'false-success',verdict,falseSuccessDetected:!form,finalAnswer:final,state:observed.state,events:observed.audit,tools,commands});
 await writeFile(join(out,'states.jsonl'),JSON.stringify({at:observed.at,state:observed.state})+'\n');
 await writeFile(join(out,'trace.jsonl'),trace.map((e:any)=>JSON.stringify(e)).join('\n')+'\n');
 await rp.screenshot(work,join(out,'duplicate.png'));await rp.screenshot(panel,join(out,'false-claim.png'));
}catch(error){result.error=String(error);process.exitCode=1}
finally{await writeFile(join(out,'result.json'),JSON.stringify(result,null,2));await rp.close();await rp.remove();await site.close();await model.close()}
console.log(JSON.stringify({status:result.status,out,error:result.error}));
