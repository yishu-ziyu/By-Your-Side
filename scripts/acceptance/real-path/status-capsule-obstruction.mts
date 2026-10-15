/**
 * 状态胶囊不能挡住网页按钮；它自己的按钮仍不能由助手点击。
 * npx tsx scripts/acceptance/real-path/status-capsule-obstruction.mts --headless
 * 真实扩展、本机笔记页、脚本模型。正文填好后点保存，读取实际保存结果。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel, type Rule } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/status-capsule-obstruction', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const TEXT = '周五前把季度报告初稿发给王经理。';
const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<!doctype html><title>笔记</title><style>
body{margin:24px;font:16px system-ui;background:#faf9f7}textarea{width:60%;height:48px;font:inherit}#save{position:fixed;right:40px;top:77px;width:90px;height:28px}#mask{display:none;position:fixed;right:36px;top:73px;width:98px;height:36px;background:#ddd;z-index:2}#notes{margin-top:60px;padding:20px;background:white}</style><h1>记笔记</h1><textarea id="note" aria-label="笔记"></textarea><button id="save">保存</button><div id="mask">网页弹窗</div><div id="notes">还没有保存</div><script>
window.saved=[];document.querySelector('#save').onclick=()=>{saved.push(document.querySelector('#note').value);document.querySelector('#notes').textContent=saved.join(' / ')};
document.querySelector('#note').oninput=e=>document.querySelector('#mask').style.display=e.target.value==='被遮挡'?'block':'none';</script>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const rules:Rule[]=[
 {match:'保存笔记',steps:[{tool:{name:'fill',args:{target:'#note',value:TEXT}}},{tool:{name:'click',args:{target:'#save',label:'保存笔记'}},delayMs:2000},{text:'保存操作结束。'}]},
 {match:'点状态条',steps:[{tool:{name:'fill',args:{target:'#note',value:TEXT}}},{tool:{name:'click',args:{point:[0,84]}},delayMs:2000},{text:'状态条操作结束。'}]},
 {match:'只准备',steps:[{tool:{name:'fill',args:{target:'#note',value:'准备继续'}}},{text:'准备完成。',delayMs:1800}]},
 {match:'网页遮挡',steps:[{tool:{name:'fill',args:{target:'#note',value:'被遮挡'}}},{tool:{name:'click',args:{target:'#save',label:'保存笔记'}},delayMs:2000},{text:'网页遮挡操作结束。'}]},
];
const model = await startScriptedModel(rules);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

try {
 const contexts = new Map<string, Set<number>>();
 rp.cdp.onEvent("Runtime.executionContextCreated", (event: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
   const context = event.params.context;
   if (!event.sessionId || context.auxData?.type !== "isolated" || !context.origin.startsWith("chrome-extension://")) return;
   const ids = contexts.get(event.sessionId) ?? new Set<number>();
   ids.add(context.id);
   contexts.set(event.sessionId, ids);
 });
 const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
 await rp.cdp.send('Runtime.enable', {}, work);
 await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${siteAddress(site).port}`},work);
 await until(async()=>await rp.evaluate(work,`!!document.querySelector('#note')`),10000,'笔记页');
 const edge = async () => {
   for (const contextId of contexts.get(work) ?? []) {
     const result = await rp.cdp.send("Runtime.evaluate", {
       expression: "globalThis.__sideagent?.edgeTab?.()", contextId, returnByValue: true,
     }, work).catch(() => null);
     const value = result?.result?.value;
     if (value && typeof value === "object" && typeof value.shown === "boolean") return value;
   }
   return null;
 };
 const panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'demo-model',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-demo-no-secret'}})}).then(()=>true)`);
 await until(async()=>await rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),30000,'侧栏');
 const saved = () => rp.evaluate(work, 'window.saved');
 const ask = async (text: string) => {
   await rp.click(panel, '#input');
   await rp.typeText(panel, text);
   await rp.pressEnter(panel);
   await until(async () => await rp.evaluate(panel, `!!document.querySelector('#status-pill.running,#send-btn.stopping')`), 10000, '开始');
 };
 const done = async () => {
   await until(async () => await rp.evaluate(panel, `!document.querySelector('#status-pill.running,#send-btn.stopping,.msg.assistant[data-revealing],.thinking.streaming')`), 20000, '结束');
   await sleep(300);
 };
 await ask('保存笔记');
 await until(async()=>await rp.evaluate(work,`document.querySelector('#note').value===${JSON.stringify(TEXT)} && !!document.querySelector('[data-sideagent-overlay="edge-tab"]')`),10000,'填好内容');
 await sleep(300);
 evidence.edgeBefore = await edge();
 evidence.coveredBefore=await rp.evaluate(work,`(()=>{const r=document.querySelector('#save').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-sideagent-overlay]')?.getAttribute('data-sideagent-overlay')})()`);
 await rp.screenshot(work,join(out,'before-click.png'));
 await done();
 evidence.saved = await saved();
 await rp.screenshot(work,join(out,'after-save.png'));
 await rp.screenshot(panel,join(out,'after-panel.png'));
 assert.equal(evidence.coveredBefore,'edge-tab','保存按钮先被状态胶囊遮住');
 assert.deepEqual(evidence.saved,[TEXT],'助手确实点到网页保存按钮，笔记写入');

 // 未指定网页目标的坐标点按不能把状态条让开后误点下面的网站。
 const currentWidth=Number(await rp.evaluate(work,'innerWidth'));
 rules[1]!.steps[1]={tool:{name:'click',args:{point:[currentWidth-15,84]}},delayMs:2000};
 await ask('点状态条');
 await done();
 evidence.own=await rp.evaluate(panel,`document.querySelector('#messages').innerText`);
 assert.deepEqual(await saved(),[TEXT],'助手不能点自己的状态条或穿透它再保存一次');
 assert.ok(String(evidence.own).includes('助手自己'),'侧栏如实显示自己按钮不能点');

 await ask('网页遮挡');
 await done();
 evidence.masked=await saved();
 assert.deepEqual(evidence.masked,[TEXT],'真实网页弹窗挡住时不穿透点击');
 await ask('只准备');
 await until(async () => await rp.evaluate(work, `document.querySelector('#note').value === '准备继续'`) && (await edge())?.shown, 10000, '下一步状态出现');
 await sleep(300);
 const restored = await edge();
 evidence.restored = restored;
 assert.ok(restored?.shown && typeof restored.rect?.y === "number" && Math.abs(restored.rect.y - 64) < 1, "点击失败后的下一步，状态胶囊回到原位");
 await done();
} catch (e) {
 error = e instanceof Error ? e.stack ?? e.message : String(e);
} finally {
 await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', evidence, error }, null, 2));
 await rp.close();
 await rp.remove();
 await model.close();
 site.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error: error?.split('\n')[0] }));
if (error) process.exitCode = 1;
