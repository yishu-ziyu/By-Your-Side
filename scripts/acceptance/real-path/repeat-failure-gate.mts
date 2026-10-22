/** Real extension and local scripted model: refuse a known parameter mistake, allow repair,
 * reset on user input, and keep refusals inside the existing no-progress budget. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until,sleep} from './harness.mts';
import {configureViaSettings} from './inproc-config.mts';
import {startScriptedModel,type Step} from './scripted-model.mts';

requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-repeat-failure-gate`);
await mkdir(out,{recursive:true});
const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>重复失败练习页</title><h1>可以改好继续</h1><button id="count" onclick="window.clickCount=(window.clickCount||0)+1">增加计数</button>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}`;
let order=0;
const bad=(url:string)=>({tool:{name:'tabs',args:{action:'list',url,decisionGuard:++order%2?{observationId:'fixture',operation:'switch_tab',sourceTabId:1}:{sourceTabId:1,operation:'switch_tab',observationId:'fixture'}}}} satisfies Step);
const a=`${origin}/a`,b=`${origin}/b`;
const FIX='重复失败后换法验收',RESET='用户主动重试验收',BUDGET='持续无效操作预算验收',GENERIC='通用失败标签验收';
type Payload={tools?:unknown[];messages?:Array<{role:string;content?:unknown}>};
const payloads:Payload[]=[];
const model=await startScriptedModel([
 {match:FIX,steps:[{tools:[bad(a).tool,bad(b).tool]},{text:'并行结果占位，不应执行。'},bad(a),{tool:{name:'tabs',args:{action:'active'}}},bad(a),bad(b),bad(b),{tool:{name:'tabs',args:{action:'open',url:`${origin}/opened`}}},{tool:{name:'click',args:{target:'#count'}}},{tool:{name:'click',args:{target:'#count'}}},{text:'已换正确方法打开网页，并增加计数两次。'}]},
 {match:RESET,steps:[bad(a),{text:'用户主动重试已执行一次。'}]},
 {match:GENERIC,steps:[...['#tagged-fixture','#tagged-fixture','#tagged-fixture','#untagged-fixture','#untagged-fixture','#untagged-fixture'].map(target=>({tool:{name:'read_element',args:{target}}})),{text:'另一种工具也能改法，未标注错误仍可重试。'}]},
 {match:BUDGET,steps:[...Array.from({length:30},()=>bad(a)),{text:'不该走到这份最终回答。'}]},
],undefined,p=>payloads.push(p as Payload));
// Inject only the error-producing tool into a private copy of the frozen extension.
// The policies, durable loop, sidebar and browser remain the actual product implementation.
const prepared=process.env.SIDEAGENT_ACCEPTANCE_DIST;
assert.ok(prepared,'run with npm run lab -- case repeat-failure-gate');
const fixtureDist=join(out,'fixture-extension');
await cp(prepared,fixtureDist,{recursive:true});
const bundleFile=join(fixtureDist,'inproc.js');
const bundle=await readFile(bundleFile,'utf8');
const anchor='const data = await call2("read_element", params);';
assert.equal(bundle.split(anchor).length,2,'one real read_element implementation');
await writeFile(bundleFile,bundle.replace(anchor,`if (params.target === '#tagged-fixture' || params.target === '#untagged-fixture') {
  rpc.markCallRejected?.(_id);
  return {content:[{type:'text',text:'fixture argument failure'}],details:params.target === '#tagged-fixture' ? {failure:{kind:'invalid_arguments',retry:'change_input'}} : {},isError:true};
}
${anchor}`));
const rp=await launchRealPath({dist:fixtureDist});
let panel='',error:string|null=null;
const evidence:Record<string,unknown>={};
const content=(v:unknown):string=>typeof v==='string'?v:Array.isArray(v)?v.map(p=>p&&typeof p==='object'&&'text' in p?String(p.text):'').join(''):'';
const receipts=(marker:string)=>{
 const last=payloads.findLast(p=>p.tools?.length&&p.messages?.some(m=>m.role==='user'&&content(m.content).includes(marker)));
 const messages=last?.messages??[];
 const at=messages.findLastIndex(m=>m.role==='user'&&content(m.content).includes(marker));
 return messages.slice(at+1).filter(m=>m.role==='tool').map(m=>content(m.content));
};
const text=()=>rp.evaluate(panel,'document.querySelector("#messages")?.textContent??""');
async function send(task:string,answer:string){
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 await until(async()=>String(await text()).includes(answer)&&await rp.evaluate(panel,'!document.querySelector("#status-pill")?.classList.contains("running")')||undefined,60000,answer);
 await sleep(400);
}
try{
 const work=await until(async()=>(await rp.targets()).find(t=>t.type==='page'&&t.url==='about:blank'),10000,'fixture');
 await rp.cdp.send('Page.navigate',{url:origin},await rp.attach(work.targetId));
 panel=await rp.attach(await rp.openSidePanel());
 await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
 const config=await configureViaSettings(rp,panel,{providerId:'custom',modelId:'demo-model',credential:{type:'api_key',key:'local-demo-no-secret'}},{baseUrl:model.baseUrl});
 await rp.cdp.send('Target.closeTarget',{targetId:config.settingsTargetId});
 await until(async()=>await rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,60000,'sidebar ready');
 await send(`${FIX}：打开练习页并增加计数两次。`,'已换正确方法打开网页，并增加计数两次。');
 const fixed=receipts(FIX);evidence.fixed=fixed;
 assert.equal(fixed.length,10,'all repair steps reached the model');
 assert.ok(!fixed[1]!.includes('本次没有执行'),'a different URL gets its first attempt');
 assert.ok(fixed[4]!.includes('本次没有执行'),'third failed A operation is refused even after a successful tabs operation');
 assert.ok(!fixed[5]!.includes('本次没有执行'),'B gets its second attempt');
 assert.ok(fixed[6]!.includes('本次没有执行'),'third failed B operation is refused independently');
 const opened=await until(async()=>(await rp.targets()).find(t=>t.url===`${origin}/opened`),10000,'corrected operation opened page');
 assert.equal(await rp.evaluate(await rp.attach(opened.targetId),'window.clickCount'),2,'successful repeated clicks really execute twice');
 await rp.screenshot(panel,join(out,'repaired.png'));
 await send(`${RESET}：按我的新要求重新试一次。`,'用户主动重试已执行一次。');
 const reset=receipts(RESET);evidence.reset=reset;
 assert.ok(reset[0]&&!reset[0].includes('本次没有执行'),'new user input resets previous failure lock');
 await send(`${GENERIC}：处理读取失败后继续。`,'另一种工具也能改法，未标注错误仍可重试。');
 const generic=receipts(GENERIC);evidence.generic=generic;
 assert.ok(generic[2]?.includes('本次没有执行'),'the same tag works for read_element without a tool-specific policy rule');
 assert.ok(generic[5]&&!generic[5].includes('本次没有执行'),'untagged errors are not permanently locked');
 const start=model.requests.length;
 const payloadStart=payloads.length;
 await send(`${BUDGET}：打开练习页面。`,'原地打转');
 await sleep(1000);
 const requests=model.requests.slice(start);evidence.budgetRequests=requests;
 assert.ok(requests.filter(r=>r.tools).length<=17,'refusals cannot generate unlimited model rounds');
 assert.ok(!String(await text()).includes('不该走到这份最终回答'),'existing no-progress budget ends the ineffective loop');
 assert.ok(!payloads.slice(payloadStart).some(p=>p.messages?.some(m=>m.role==='user'&&content(m.content).startsWith('[GOAL CHECK]'))),'no goal continuation after no-progress stop');
 evidence.budgetReceipts=receipts(BUDGET);
 await rp.screenshot(panel,join(out,'budget-stop.png'));
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);evidence.panel=panel?await text().catch(()=>null):null;}
finally{
 await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence,requests:model.requests},null,2));
 await rp.close();await rp.remove();await model.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));
if(error)process.exitCode=1;
