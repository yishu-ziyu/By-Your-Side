/** 暂停站点笔记：旧数据不进入任务、不再生成；仍可从管理列表查看和删除。 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-site-notes`);
await mkdir(out, { recursive: true });
const marker = "SYNTHETIC-OLD-NOTE-DO-NOT-INJECT";
const kept = "SYNTHETIC-SECOND-NOTE-KEEP";
const seed = JSON.stringify({format:1,sites:{"127.0.0.1":[{text:marker,runId:"synthetic-old",at:1},{text:kept,runId:"synthetic-keep",at:2}]}});
const ask = "暂停站点笔记检查：在这个搜索页输入 fixture，打开结果页。";
const final = "暂停站点笔记检查完成。";
const site = createServer((req,res) => res.writeHead(200,{"content-type":"text/html; charset=utf-8"}).end(req.url?.startsWith("/results") ? '<title>Fixture Results</title><h1>One result found.</h1>' : '<title>Fixture Search</title><label>Query <input id="q"></label><button id="go" onclick="location.href=\'/results\'">Go</button>'));
await new Promise<void>(r=>site.listen(0,"127.0.0.1",r));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;
let noteCalls = 0;
const received: unknown[] = [];
const model = await startScriptedModel([
  {match:'"visitedHosts"',steps:[{text:JSON.stringify({notes:[{host:"127.0.0.1",tip:"Use the Go button after entering a query in the search box."}]})}]},
  {match:'"goalPage"',steps:[{text:JSON.stringify({status:"done",remaining:"",correction:""})}]},
  {match:ask,steps:[{tool:{name:"navigate",args:{url:url+"?tenant=synthetic-b"}}},{tool:{name:"fill",args:{target:"#missing",value:"fixture"}}},{tool:{name:"fill",args:{target:"#q",value:"fixture"}}},{tool:{name:"click",args:{target:"#go"}}},{text:final}]},
],undefined,payload=>{received.push(payload);if(JSON.stringify(payload).includes('"visitedHosts"') || JSON.stringify(payload).includes('\\"visitedHosts\\"')) noteCalls++;});
const rp = await launchRealPath();
const checks:Array<{name:string;pass:boolean;actual:Json}>=[];
const check=(name:string,pass:boolean,actual:Json)=>{checks.push({name,pass,actual});console.log(`${pass?"PASS":"FAIL"} ${name}`,JSON.stringify(actual));};
let panel="";
let firstPanelId="";
const readNotes=()=>rp.evaluate(panel, `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-memory',1);r.onerror=()=>reject(String(r.error));r.onsuccess=()=>{const d=r.result,q=d.transaction('kv').objectStore('kv').get('site-notes');q.onsuccess=()=>{resolve(q.result??null);d.close()};q.onerror=()=>reject(String(q.error));};})`);
try {
 const work=await rp.attach((await rp.targets()).find(t=>t.url==="about:blank")!.targetId);
 await rp.cdp.send("Page.navigate",{url},work);
 firstPanelId=await rp.openSidePanel();
 panel=await rp.attach(firstPanelId);
 await rp.evaluate(panel,`new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-memory',1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('kv'))r.result.createObjectStore('kv')};r.onerror=()=>reject(String(r.error));r.onsuccess=()=>{const d=r.result,t=d.transaction('kv','readwrite');t.objectStore('kv').put(${JSON.stringify(seed)},'site-notes');t.oncomplete=()=>{resolve(true);d.close()};t.onerror=()=>reject(String(t.error));};})`);
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:"custom",modelId:"fixture",baseUrl:model.baseUrl},"inproc_cred:custom":{type:"api_key",key:"local-fixture"}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false'),60000,"侧栏就绪");
 await rp.click(panel,"#input");await rp.typeText(panel,ask);await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,`document.querySelector('#messages')?.textContent.includes(${JSON.stringify(final)}) && !document.querySelector('#status-pill')?.classList.contains('running')`),90000,"原任务完成");
 await sleep(2000);
 const requests=JSON.stringify(received);
 check("任务请求不含旧站点笔记",!requests.includes(marker)&&!requests.includes(kept),{containsOldNote:requests.includes(marker),containsSecondNote:requests.includes(kept)});
 check("完成任务后没有学习调用",noteCalls===0,{noteCalls});
 const after=await readNotes();
 check("完成任务后旧数据原样保留且没有新笔记",after===seed,{unchanged:after===seed});
 await rp.screenshot(panel,join(out,"task-finished.png"));
 const manager=await rp.evaluate(panel,'!!document.querySelector("#site-note-management")');
 check("管理入口存在",manager===true,{manager:manager===true});
 if(manager){
  await rp.click(panel,"#memory-open");
  await until(()=>rp.evaluate(panel,'!document.querySelector("#memory-drawer").hidden && document.querySelector("#memory-drawer").getAnimations().every(a=>a.playState!=="running")'),10000,"管理抽屉打开");
  await rp.click(panel,"#site-note-management summary");
  await until(()=>rp.evaluate(panel,`document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(marker)})`),15000,"旧笔记列表");
  check("管理列表能读到合成旧笔记",true,{visible:true});
  await rp.screenshot(panel,join(out,"management-before-delete.png"));
  const windowId=await rp.evaluate(panel,'chrome.windows.create({url:"about:blank"}).then(w=>w.id)') as number;
  await rp.openSidePanel(windowId);
  const secondId=await until(async()=>(await rp.targets()).find(t=>t.type==="page"&&t.url.startsWith(`chrome-extension://${rp.extensionId}/sidepanel.html`)&&t.targetId!==firstPanelId)?.targetId,15000,"独立第二侧栏");
  const second=await rp.attach(secondId);
  const actualWindow=await rp.evaluate(second,'chrome.windows.getCurrent().then(w=>w.id)');
  if(actualWindow!==windowId) throw new Error("第二侧栏不属于新窗口");
  await until(()=>rp.evaluate(second,'document.querySelector("#send-btn")?.disabled===false'),30000,"第二窗口侧栏就绪");
  await rp.click(second,"#memory-open");
  await until(()=>rp.evaluate(second,'!document.querySelector("#memory-drawer").hidden && document.querySelector("#memory-drawer").getAnimations().every(a=>a.playState!=="running")'),10000,"第二窗口抽屉打开");
  await rp.click(second,"#site-note-management summary");
  await until(()=>rp.evaluate(second,`document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(marker)})`),15000,"第二窗口显示原笔记");
  await rp.click(panel,"#site-note-management-body p button");
  await until(()=>rp.evaluate(second,`!document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(marker)}) && document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(kept)})`),15000,"第二窗口自动更新删除结果");
  check("另一窗口自动显示删除结果",true,{refreshed:true});
  await until(async()=>!String(await readNotes()).includes(marker),15000,"删除存储读回");
  await rp.click(panel,"#site-note-refresh");
  await until(()=>rp.evaluate(panel,`!document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(marker)}) && document.querySelector('#site-note-management-body')?.textContent.includes(${JSON.stringify(kept)})`),15000,"删除后列表读回");
  const deleted=String(await readNotes());
  check("只删除用户选中的笔记，其余保留",!deleted.includes(marker)&&deleted.includes(kept),{removed:!deleted.includes(marker),otherKept:deleted.includes(kept)});
  await rp.screenshot(panel,join(out,"management-after-delete.png"));
 }
} catch(error){check("流程完成",false,String(error));if(panel)await rp.screenshot(panel,join(out,"failure.png")).catch(()=>{});}
finally{await writeFile(join(out,"result.json"),JSON.stringify({checks,noteCalls,requests:received,requestSummary:model.requests},null,2));await rp.close();await rp.remove();await model.close();site.closeAllConnections();site.close();}
console.log(`${checks.length&&checks.every(c=>c.pass)?"PASS":"FAIL"} site-notes → ${out}`);
process.exitCode=checks.length&&checks.every(c=>c.pass)?0:1;
