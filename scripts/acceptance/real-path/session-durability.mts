/** Failures: lost model context/files on full browser restart, image evicts text,
 * cross-conversation file leak, deleted file resurrects, acceptance before failed commit.
 * Uses the real sidepanel + extension and a scripted provider; request evidence is independent of its answer.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until, sleep, siteAddress, watchInproc, type JsonRecord } from './harness.mts';
import { configureViaSettings } from './inproc-config.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const code=randomUUID(), csv=`代号,数量\n${code},7\n`, requests: Array<{messages?: unknown[];tools?: unknown[]}> = [];

const model=await startScriptedModel([
 {match:'保存恢复材料',steps:[{tool:{name:'artifacts',args:{command:'create',filename:'resume.csv',content:csv}}},{tool:{name:'screenshot',args:{forUser:true}}},{text:'材料已保存。'}]},
 {match:'恢复核对',steps:[{tool:{name:'artifacts',args:{command:'get',filename:'resume.csv'}}},{text:'恢复核对完毕。'}]},
 {match:'防重复验收',steps:[{tool:{name:'browser_run',args:{code:"return await browser.js({code: `fetch('/commit',{method:'POST'}).then(r=>r.text())`});"}}},{text:'防重复核对结束。'}]},
 {match:'保存故障验收',steps:[{tool:{name:'artifacts',args:{command:'create',filename:'failure.csv',content:'item,count\nA,1\n'}}},{text:'存储故障已核对。'}]},
 {match:'删除恢复文件',steps:[{tool:{name:'artifacts',args:{command:'delete',filename:'resume.csv'}}},{text:'已删除恢复文件。'}]},
],undefined,p=>requests.push(p));

let commits=0;

const site=createServer((q,r)=>{if(q.url==='/commit'){commits++;

return;}

return r.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>恢复验收</title><canvas width="1100" height="800"></canvas><script>const c=document.querySelector("canvas").getContext("2d"),d=c.createImageData(1100,800);crypto.getRandomValues(d.data.subarray(0,65536));for(let i=65536;i<d.data.length;i++)d.data[i]=d.data[i%65536];for(let i=3;i<d.data.length;i+=4)d.data[i]=255;c.putImageData(d,0,0);</script>');});

await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));

const out=join(REPO,'out/acceptance/real-path',new Date().toISOString().replace(/[:.]/g,'-')+'-session-durability');

await mkdir(out,{recursive:true});

const rp=await launchRealPath();

let panel='',failure:string|null=null;

let logs:Awaited<ReturnType<typeof watchInproc>>|undefined;

const evidence:JsonRecord={};

const state=()=>rp.evaluate(panel,`({ready:document.querySelector('#send-btn')?.disabled===false,busy:document.querySelector('#send-btn')?.classList.contains('stopping'),text:document.querySelector('#messages')?.innerText,body:document.body?.innerText?.slice(0,3000),selected:[...document.querySelectorAll('[data-conversation-id]')].map(e=>({id:e.dataset.conversationId,checked:e.getAttribute('aria-checked')})),cards:[...document.querySelectorAll('.artifact-card')].map(e=>({name:e.dataset.filename,deleted:e.dataset.deleted,image:e.querySelector('img')?.src}))})`);

async function open(){panel=await rp.attach(await rp.openSidePanel());await until(async()=>((await state())?.ready)||undefined,20000,'侧栏可发送');}

async function send(text:string,marker:string){await rp.click(panel,'#input');await rp.typeText(panel,text);await rp.pressEnter(panel);await until(async()=>{const s=await state();

return !s.busy&&s.text?.includes(marker)?s:undefined;},60000,marker);await sleep(500);}

try{
 await open();await configureViaSettings(rp,panel,{providerId:'custom',modelId:'demo-model',credential:{type:'api_key',key:'test-key'}},{asCustom:true,baseUrl:model.baseUrl});
 logs=await watchInproc(rp,rp.extensionId);
 const work=await rp.cdp.send('Target.createTarget',{url:`http://127.0.0.1:${siteAddress(site).port}`});await rp.cdp.send('Target.activateTarget',{targetId:work.targetId});await sleep(500);
 await send(`保存恢复材料。当前任务代号是${code}。CSV内容必须原样保存。`,'材料已保存');
 const before=await state();await rp.screenshot(panel,join(out,'before.png'));evidence.before=before;
 assert.ok(before.cards.some(c=>c.image?.length>256*1024),'真实大图覆盖历史预算边界');
 evidence.historyBefore=await rp.evaluate(panel,`chrome.storage.local.get(null).then(v=>Object.fromEntries(Object.entries(v).filter(([k])=>k.startsWith("history:")).map(([k,v])=>[k,{bytes:JSON.stringify(v).length,items:v.entries?.map(e=>({seq:e.seq,kind:e.item.kind,event:e.item.msg?.event?.kind,bytes:JSON.stringify(e).length,text:e.item.text?.slice(0,100)}))}])))`);

 await rp.restart();await open();await until(async()=>((await state()).text?.includes(code))||undefined,10000,"原会话历史恢复");const after=await state();evidence.after=after;await rp.screenshot(panel,join(out,'after.png'));
 assert.ok(after.text.includes(code),'大图不挤掉旧文字');assert.ok(after.cards.some(c=>c.name==='resume.csv'&&c.deleted!=='true'),'文件卡片恢复');
 await until(async()=>((await state()).cards.some(c=>c.image?.length>256*1024))||undefined,10000,"原图片恢复");
 const compact=await rp.evaluate(panel,`(()=>{const card=document.querySelector('.artifact-card[data-kind="image"]'),img=card.querySelector('img'),input=document.querySelector('#input');return {imageHeight:img.getBoundingClientRect().height,cardHeight:card.getBoundingClientRect().height,bottom:card.getBoundingClientRect().bottom,inputTop:input.getBoundingClientRect().top};})()`);
 assert.ok(compact.imageHeight<=48,'默认缩略图不占满消息区');assert.ok(compact.bottom<compact.inputTop,'图片名称和操作在输入框上方');evidence.compactCard=compact;
 const noModelBefore=requests.length;await rp.click(panel,'.artifact-card[data-kind="image"] .artifact-preview-toggle');
 const expanded=await rp.evaluate(panel,`document.querySelector('.artifact-preview').getBoundingClientRect().height`);assert.ok(expanded>48,'展开可核对原图');await rp.screenshot(panel,join(out,'expanded.png'));
 await rp.click(panel,'.artifact-card[data-kind="image"] .artifact-preview-toggle');assert.equal(requests.length,noModelBefore,'展开不调用模型');await rp.screenshot(panel,join(out,'compact.png'));
 const offset=requests.length;await send('恢复核对：读取resume.csv，并按原任务代号核对。','恢复核对完毕');
 const main=requests.slice(offset).filter(r=>r.tools?.length);assert.ok(main.some(r=>JSON.stringify(r.messages).includes(code)),'重启后模型收到原随机代号');assert.ok(main.some(r=>JSON.stringify(r.messages).includes(csv.replace(/\n/g,'\\n'))),'模型get收到原CSV');
 await rp.click(panel,'.artifact-card[data-filename="resume.csv"] .artifact-open');const viewer=await until(async()=>(await rp.targets()).find(t=>t.url.includes('/artifact-viewer.html')),10000,'旧文件打开');const vs=await rp.attach(viewer.targetId);await until(async()=>(await rp.evaluate(vs,'document.body.innerText')).includes(code),10000,'查看页原文');
 await rp.cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:rp.dirs.downloads});await rp.click(panel,'.artifact-card[data-filename="resume.csv"] .artifact-download');const bytes=await until(()=>readFile(join(rp.dirs.downloads,'resume.csv')).catch(()=>undefined),10000,'旧CSV下载');assert.equal(bytes.toString('utf8'),'\uFEFF'+csv);const image=(await state()).cards.find(c=>c.image);assert.ok(image?.name&&image.image);
 await rp.click(panel,`.artifact-card[data-filename="${image.name}"] .artifact-download`);
 const png=await until(()=>readFile(join(rp.dirs.downloads,image.name)).catch(()=>undefined),10000,'旧图片下载');assert.deepEqual(png,Buffer.from(image.image.split(',')[1],'base64'));evidence.imageSha256=createHash('sha256').update(png).digest('hex');
 evidence.csvSha256=createHash('sha256').update(bytes).digest('hex');
 // 一直停在默认对话时扩展不另存选中项，缺省就是 default。
 const originalId=String(await rp.evaluate(panel,'chrome.storage.local.get("selectedConversationId").then(v=>v.selectedConversationId ?? "default")'));
 const crossOffset=requests.length;
 await rp.click(panel,'#conversation-new');await until(async()=>String(await rp.evaluate(panel,'chrome.storage.local.get("selectedConversationId").then(v=>v.selectedConversationId)'))!==originalId,10000,'新会话就绪');
 // 不等侧栏换完就开口：新会话建好前发的这条，必须进新会话（docs/evals/20261009-new-conversation-send.md）。
 await send('恢复核对：读取resume.csv。','恢复核对完毕');
 const cross=requests.slice(crossOffset).filter(r=>r.tools?.length);assert.ok(cross.some(r=>JSON.stringify(r.messages).includes('找不到 resume.csv')),'新会话不能读旧文件');assert.ok(cross.every(r=>!JSON.stringify(r.messages).includes(code)),'会话模型上下文不混用');evidence.crossConversation=true;
 await rp.click(panel,'#conversation-switcher');await rp.click(panel,`[data-conversation-id="${originalId}"]`);await until(async()=>(await state()).text?.includes(code),10000,'切回原会话');
 await send('删除恢复文件resume.csv。' ,'已删除恢复文件');await rp.restart();await open();assert.ok((await state()).cards.every(c=>c.name!=='resume.csv'||c.deleted==='true'),'删除不复活');
 const work2=await rp.cdp.send('Target.createTarget',{url:`http://127.0.0.1:${siteAddress(site).port}`});await rp.cdp.send('Target.activateTarget',{targetId:work2.targetId});await sleep(300);
 await rp.click(panel,'#input');await rp.typeText(panel,'防重复验收：向当前页提交一次，完成后停止。');await rp.pressEnter(panel);
 await until(async()=>commits===1||undefined,20000,'真实提交已发生，回执挂起');
 await rp.restart({abrupt:true});await open();await sleep(500);assert.equal(commits,1,'重启不自动重放');
 const recoveryPage=await rp.cdp.send('Target.createTarget',{url:`http://127.0.0.1:${siteAddress(site).port}`});await rp.cdp.send('Target.activateTarget',{targetId:recoveryPage.targetId});await sleep(300);
 const resumeOffset=requests.length;await send('继续原任务。','防重复核对结束');assert.equal(commits,1,'继续不重复提交');
 assert.ok(requests.slice(resumeOffset).some(r=>JSON.stringify(r.messages).includes('[RESTART CONTINUATION]') && JSON.stringify(r.messages).includes('unknown')),'恢复材料进入模型');evidence.noReplay={commits,browserCrash:true};
 const inproc=await until(async()=>(await rp.targets()).find(t=>t.url.endsWith('/inproc.html')),10000,'恢复核心');const ips=await rp.attach(inproc.targetId);
 await rp.evaluate(ips,`(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(this.transaction.db.name==='sideagent-session-data'&&String(key).startsWith('artifact:'))throw new Error('acceptance-disk-failure');return put.call(this,value,key);};return true;})()`);
 const errorOffset=requests.length;await send('保存故障验收：生成failure.csv。','存储故障已核对');
 assert.ok((await state()).cards.every(c=>c.name!=='failure.csv'),'失败没有文件卡片');
 assert.ok(requests.slice(errorOffset).some(r=>JSON.stringify(r.messages).includes('acceptance-disk-failure')),'工具回报存储失败');evidence.storageFailure=true;
 await rp.evaluate(ips,`(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(this.transaction.db.name==='sideagent-session-data'&&String(key).startsWith('pi:'))throw new Error('acceptance-checkpoint-failure');return put.call(this,value,key);};return true;})()`);
 const rejectOffset=requests.length;
 await send('新的保存故障验收任务：尚未保存时不能开始。','任务未能保存到本地');
 assert.equal(requests.slice(rejectOffset).filter(r=>r.tools?.length).length,0,'检查点失败不能启动主模型');evidence.acceptanceFailure=true;
 evidence.requests=JSON.parse(JSON.stringify(requests));evidence.pass=true;
}catch(e){failure=String(e);evidence.pass=false;evidence.failure=failure;evidence.failureState=await state().catch(()=>null);evidence.failureStorage=await rp.evaluate(panel,`chrome.storage.local.get(null).then(v=>({selected:v.selectedConversationId,historyKeys:Object.keys(v).filter(k=>k.startsWith("history:"))}))`).catch(()=>null);evidence.requests=JSON.parse(JSON.stringify(requests));

if(logs)await writeFile(join(out,'inproc.log'),logs.logs());await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});console.error(e);}finally{await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));await rp.close();await rp.remove();await model.close();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));}

console.log(out);

if(failure)process.exitCode=1;
