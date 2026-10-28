/** Real extension UI with a local model; the panel port holds/rejects requests to exercise delivery states. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-material-delivery`);
await mkdir(out, { recursive: true });
const checks: { name: string; pass: boolean; actual: Json }[] = [];
const check = (name: string, pass: boolean, actual: Json = null) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };
const received: string[] = [];
const model = await startScriptedModel([{ match: '材料检查', steps: [{ text: '已读取附件，暗号是青柠七号。' }] }], undefined, payload => { if (payload.tools?.length) received.push(JSON.stringify(payload.messages)); });
const rp = await launchRealPath();
let panel: string | null = null;
const hook = `(() => {
 const connect = chrome.runtime.connect.bind(chrome.runtime);
 window.__mode = 'pass'; window.__sent = []; window.__listeners = [];
 chrome.runtime.connect = (...args) => {
   const port = connect(...args);
   if (port.name !== 'sideagent-panel') return port;
   const post = port.postMessage.bind(port), add = port.onMessage.addListener.bind(port.onMessage);
   port.onMessage.addListener = fn => { window.__listeners.push(fn); add(fn); };
   window.__release = () => { window.__mode='pass'; post(window.__pending); };
   port.postMessage = msg => {
     const r = msg.kind === 'client' && msg.msg.type === 'task_action' ? msg.msg.request : null;
     if (!r || !['start','steer'].includes(r.action)) return post(msg);
     window.__sent.push(r);
     if (window.__mode === 'hold') { window.__pending=msg; return; }
     if (window.__mode === 'failed' || window.__mode === 'unknown') {
       const status=window.__mode;
       const receipt={...r, runId:null, text:r.text||'', targetTitle:'材料检查', status, message: status==='failed'?'验收通道拒绝，未启动任务':'送达结果尚无法确认', updatedAt:Date.now()};
       setTimeout(() => window.__listeners.forEach(fn => fn({kind:'server',msg:{type:'agent_event',event:{kind:'notice',message:receipt.message,receipt}}})),0);
       return;
     }
     return post(msg);
   };
   return port;
 };
})();`;
try {
 panel = await rp.attach(await rp.openSidePanel());
 await rp.cdp.send('Page.enable', {}, panel);
 await rp.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: hook }, panel);
 await rp.cdp.send('Page.reload', {}, panel);
 await until(async () => await rp.evaluate(panel!, '!!window.__release'), 15_000, '侧栏通道挂钩');
 await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
 await until(async () => await rp.evaluate(panel!, '!document.querySelector("#send-btn")?.disabled'), 30_000, '侧栏就绪');
 const file = join(out, 'material.txt');
 await writeFile(file, '材料暗号：青柠七号');
 const attach = async () => {
   await rp.cdp.send('DOM.enable', {}, panel!);
   const {root} = await rp.cdp.send('DOM.getDocument', {depth:0}, panel!) as { root:{nodeId:number} };
   const {nodeId} = await rp.cdp.send('DOM.querySelector', {nodeId:root.nodeId,selector:'#file-input'}, panel!) as {nodeId:number};
   await rp.cdp.send('DOM.setFileInputFiles', {nodeId,files:[file]}, panel!);
   await until(async()=>await rp.evaluate(panel!,'!!document.querySelector(".mt-row[data-kind=attachment]")'),15000,'附件读取');
 };
 const send = async (mode:string) => {
   await rp.evaluate(panel!, `window.__mode=${JSON.stringify(mode)}`);
   await rp.click(panel!,'#input'); await rp.typeText(panel!,'材料检查：读一下附件'); await rp.pressEnter(panel!);
   await sleep(1100);
 };
 await attach();
 const collapsed = await rp.evaluate(panel, 'document.querySelector(".mt-toggle")?.getAttribute("aria-expanded") === "false" && document.querySelector(".mt-list")?.getBoundingClientRect().height === 0');
 check('材料清单默认收起', collapsed === true, collapsed);
 await rp.screenshot(panel,join(out,'a-collapsed.png'));
 if (await rp.evaluate(panel,'!!document.querySelector(".mt-toggle")')) {
   await rp.click(panel,'.mt-toggle');
   check('展开后能看到真实附件', await rp.evaluate(panel,'document.querySelector(".mt-list").getBoundingClientRect().height > 0 && document.querySelector(".mt-list").textContent.includes("material.txt")') === true);
 }
 await send('hold');
 await rp.screenshot(panel,join(out,'b-sending.png'));
 const sending = await rp.evaluate(panel,'({legacy:!!document.querySelector(".task-bar:not([hidden])"), line:document.querySelector(".mt-delivery")?.textContent, height:document.querySelector(".mt-delivery")?.getBoundingClientRect().height})') as {legacy:boolean;line:string;height:number};
 check('发送中只留轻提示，无重复大卡片', !sending.legacy && sending.line?.includes('正在发送') && sending.height < 45, sending);
 if (!collapsed || sending.legacy) throw new Error('旧界面保留重复卡片或未收起材料');
 await rp.evaluate(panel,'window.__release()');
 await until(async()=>received.length>0,30000,'模型收到材料');
 await until(async()=>await rp.evaluate(panel!, '!document.querySelector(".mt-delivery") && document.querySelector("#messages").textContent.includes("青柠七号")'),30000,'送达提示消失且出现回答');
 check('收到确认后提示消失，模型确实收到附件原文', received.some(text=>text.includes('材料暗号：青柠七号')));
 await rp.screenshot(panel,join(out,'c-received.png'));
 await until(async()=>await rp.evaluate(panel!,'!document.querySelector("#status-pill")?.classList.contains("running")'),30000,'任务结束');
 await attach(); await send('failed');
 const failure = await rp.evaluate(panel,'document.querySelector(".mt-delivery")?.textContent');
 check('失败显示真实原因和重试入口', String(failure).includes('验收通道拒绝') && String(failure).includes('重试'), failure);
 await rp.screenshot(panel,join(out,'d-failed.png'));
 const original = await rp.evaluate(panel,'window.__sent.at(-1)') as {requestId:string;attachments:unknown[]};
 const receivedBeforeRetry = received.length;
 await rp.evaluate(panel,'window.__mode="pass"');
 await rp.click(panel,'.mt-delivery button');
 await until(async()=>await rp.evaluate(panel!,`window.__sent.at(-1).requestId !== ${JSON.stringify(original.requestId)}`),10000,'重试已发出');
 const retried = await rp.evaluate(panel,'window.__sent.at(-1)') as {requestId:string;attachments:unknown[]};
 check('重试保留附件，不丢原请求', JSON.stringify(original.attachments)===JSON.stringify(retried.attachments));
 await until(async()=>await rp.evaluate(panel!, '!document.querySelector(".mt-delivery") && !document.querySelector("#status-pill")?.classList.contains("running")'),30000,'重试送达');
 check('重试后模型再次收到附件原文',received.length > receivedBeforeRetry && received.at(-1)!.includes('材料暗号：青柠七号'));
 await send('unknown');
 const unknown=await rp.evaluate(panel,'document.querySelector(".mt-delivery")?.textContent');
 check('结果未知不冒充失败，也不提供盲目重试', String(unknown).includes('尚未确认') && !String(unknown).includes('重试'),unknown);
 await rp.screenshot(panel,join(out,'e-unknown.png'));
 await rp.click(panel,'.mt-delivery button');
 check('查看详情打开对应的原请求',await rp.evaluate(panel,'!!document.querySelector("details.receipt[open]")')===true);
 await rp.click(panel,'#conversation-new');
 await until(async()=>await rp.evaluate(panel!,'!document.querySelector(".mt-delivery")'),15000,'新会话无旧提示');
 check('切会话不串入旧发送状态',true);
 await attach();
 await rp.cdp.send('Page.reload',{},panel);
 await until(async()=>await rp.evaluate(panel!,'document.querySelector(".mt-count-number")?.textContent !== "0" && !!document.querySelector(".mt-row[data-kind=attachment]")'),15000,'草稿附件恢复');
 check('重开侧栏保留草稿附件且默认收起',await rp.evaluate(panel,'document.querySelector(".mt-toggle")?.getAttribute("aria-expanded")==="false"')===true);
 await rp.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]},panel);
 await rp.screenshot(panel,join(out,'f-draft-dark-reduced.png'));
} catch(error) { check('流程完成',false,String(error)); if(panel) { console.log('现场',JSON.stringify(await rp.evaluate(panel,'({hook:!!window.__release,body:document.body.innerText.slice(-2200),send:document.querySelector("#send-btn")?.disabled})').catch(String))); await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{}); } }
finally {
 await writeFile(join(out,'result.json'),JSON.stringify({status:checks.length>0&&checks.every(c=>c.pass)?'PASS':'FAIL',checks},null,2));
 await rp.close(); await rp.remove(); await model.close();
}
console.log(`证据：${out}`);
if(checks.some(c=>!c.pass)) process.exitCode=1;
