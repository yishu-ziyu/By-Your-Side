/** Actual configured GLM + actual extension. Only isolated profile data is changed.
 * Failures: file not saved as requested; model cannot recall after full browser restart;
 * model rewrites the file instead of reading it. Capture real sidepanel frames and final bytes. */
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO,launchRealPath,requireHeadless,until,sleep,siteAddress,type JsonRecord } from './harness.mts';
import { loadModelPlan,configureViaSettings } from './inproc-config.mts';

requireHeadless();

const out=join(REPO,'out/acceptance/real-path',new Date().toISOString().replace(/[:.]/g,'-')+'-session-durability-live');

await mkdir(join(out,'frames'),{recursive:true});

const plan=await loadModelPlan('zai-coding-cn/glm-5.3-flash');

const code=randomUUID(),csv=`check_code,count\n${code},7\n`;

const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>会话恢复验收</title><h1>会话恢复验收</h1><p>这是隔离测试页。</p>'));

await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));

const rp=await launchRealPath();

let panel='',fatal:string|null=null,capturing=false,frameNo=0;

const frames:Array<{file:string;at:number}>=[];

const origin=Date.now(),evidence:JsonRecord={model:'zai-coding-cn/glm-5.3-flash'};

const recorder=setInterval(async()=>{
 if(!panel||capturing)return;
 capturing=true;
 const file=join(out,'frames',String(frameNo++).padStart(4,'0')+'.png');

 try {await rp.screenshot(panel,file);frames.push({file,at:Date.now()-origin});}catch{/* Browser absent during restart. */}finally{capturing=false;}
},500);

const state=()=>rp.evaluate(panel,`({ready:document.querySelector('#send-btn')?.disabled===false,busy:!!(document.querySelector('#send-btn')?.classList.contains('stopping')||document.querySelector('#status-pill')?.classList.contains('running')||document.querySelector('.msg.assistant.streaming,.msg.assistant[data-revealing]')),answers:[...document.querySelectorAll('#messages .msg.assistant')].map(e=>e.innerText),cards:[...document.querySelectorAll('.artifact-card')].map(e=>e.dataset.filename)})`);

async function open(){panel=await rp.attach(await rp.openSidePanel());await until(async()=>(await state()).ready||undefined,20000,'侧栏就绪');}

async function send(text:string,done:(s:Awaited<ReturnType<typeof state>>)=>boolean){await rp.click(panel,'#input');await rp.typeText(panel,text);await rp.pressEnter(panel);await until(async()=>{const s=await state();

return !s.busy&&done(s)?s:undefined;},90000,'真实模型交付');await sleep(500);}

try{
 await open();await configureViaSettings(rp,panel,plan);
 const work=await rp.cdp.send('Target.createTarget',{url:`http://127.0.0.1:${siteAddress(site).port}`});await rp.cdp.send('Target.activateTarget',{targetId:work.targetId});await sleep(300);
 await send(`本会话检查口令是${code}，只用于本会话，不要保存为长期偏好。用artifacts创建probe.csv，正文必须是以下CSV原文，不增加其他行：\n${csv}`,s=>s.cards.includes('probe.csv')&&s.answers.length>0);
 await rp.cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:rp.dirs.downloads});
 await rp.click(panel,'.artifact-card[data-filename="probe.csv"] .artifact-download');
 const beforeBytes=await until(()=>readFile(join(rp.dirs.downloads,'probe.csv')).catch(()=>undefined),10000,'重启前原文件');
 evidence.originalSha256=createHash('sha256').update(beforeBytes).digest('hex');
 evidence.initialExactCsv=beforeBytes.toString('utf8')==='\uFEFF'+csv;
 await rp.screenshot(panel,join(out,'before.png'));
 evidence.before=await state();
 await rp.restart();await open();await until(async()=>(await state()).cards.includes('probe.csv')||undefined,10000,'旧文件卡片恢复');
 const prior=(await state()).answers.length;
 await send('请读取probe.csv，并回答上一轮的本会话检查口令。回复必须包含文件全部原文。不要重新生成或修改文件。',s=>s.answers.length>prior&&s.answers.at(-1)?.includes(code));
 const after=await state();assert.ok(after.answers.at(-1)?.includes(code),'真实模型想起原口令');assert.ok(after.answers.at(-1)?.includes('check_code'),'真实模型读回文件');
 await rp.screenshot(panel,join(out,'after.png'));evidence.after=after;
 await mkdir(join(rp.dirs.downloads,'restored'),{recursive:true});
 await rp.cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:join(rp.dirs.downloads,'restored')});await rp.click(panel,'.artifact-card[data-filename="probe.csv"] .artifact-download');
 const bytes=await until(()=>readFile(join(rp.dirs.downloads,'restored','probe.csv')).catch(()=>undefined),10000,'恢复后原CSV下载');assert.deepEqual(bytes,beforeBytes,'恢复文件字节必须与实际创建时一致');evidence.sha256=createHash('sha256').update(bytes).digest('hex');evidence.pass=true;
}catch(error){fatal=String(error);evidence.pass=false;evidence.failure=fatal;evidence.state=await state().catch(()=>null);await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});console.error(error);}finally{
 clearInterval(recorder);await until(async()=>!capturing||undefined,5000,'截图写完');evidence.frames=frames;await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));
 await writeFile(join(out,'frames.ffconcat'),'ffconcat version 1.0\n'+frames.map((f,i)=>`file '${f.file}'\nduration ${Math.max(0.1,((frames[i+1]?.at??f.at+500)-f.at)/1000)}\n`).join(''));
 await rp.close();await rp.remove();site.closeAllConnections();await new Promise<void>(r=>site.close(()=>r()));
}

console.log(out);

if(fatal)process.exitCode=1;
