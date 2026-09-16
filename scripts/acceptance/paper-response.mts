/** Boss-owned UI evaluator: production sidepanel bundle + CSS, stub transport only. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {existsSync,readdirSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {spawn} from 'node:child_process';
import {createCdp} from './cdp.mjs';
const cache=join(homedir(),'Library/Caches/ms-playwright');
const chromePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(n=>join(cache,n,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(p=>existsSync(p));
if(!chromePath)throw Error('Chrome for Testing is unavailable');
if(!process.argv.includes('--headless'))throw Error('Required --headless');
const out=resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6) ?? 'docs/evals/20260916-paper-response');await mkdir(out,{recursive:true});
const css=await readFile('extension/src/sidepanel/styles.css','utf8');
const mock=`globalThis.uiMessages=[];globalThis.uiListeners=[];globalThis.uiDisconnects=[];globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:f=>uiDisconnects.push(f)},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'正在查看的页面',url:'https://example.test/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
`;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url!,'http://localhost').pathname;
 if(path==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(mock);return;}
 if(path==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(path==='/'||path==='/sidepanel.html'){res.setHeader('Content-Type','text/html');res.end((await readFile('extension/sidepanel.html','utf8')).replace('<script type="module"','<script src="mock.js"></script><script type="module"'));return;}
 const p=resolve('extension/dist','.'+path);if(!p.startsWith(resolve('extension/dist')+'/'))throw Error('path');
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml'} as any)[extname(p)]??'application/octet-stream');res.end(await readFile(p));
 }catch{res.statusCode=404;res.end();}});
const report:any={ok:false,source:'production sidepanel.js and styles.css; background transport and storage are test doubles; no live Agent actions',cases:[],clicks:[],errors:[]};
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('UI evaluator timeout: '+report.stage);}
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/sidepanel.html`;
 const profile=await mkdtemp(join(tmpdir(),'paper-response-'));child=spawn(chromePath,['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
 report.stage='startup';const port=await until(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return undefined;}});
 const info:any=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 const target=await cdp.send('Target.createTarget',{url:'about:blank'});const sid=await cdp.attachSession(target.targetId);
 cdp.onEvent('Runtime.exceptionThrown',(event:any)=>report.errors.push(event.params.exceptionDetails.exception?.description??event.params.exceptionDetails.text));
 await cdp.send('Runtime.enable',{},sid);await cdp.send('Page.enable',{},sid);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sid);
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sid);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 const click=async(selector:string)=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)throw Error('not visible');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp!.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},sid);await cdp!.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},sid);await sleep(120);};
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:1000,deviceScaleFactor:1,mobile:false},sid);await cdp.send('Page.navigate',{url},sid);
 report.stage='production DOM';await until(async()=>await evaluate('!!document.querySelector("#composer-bar")&&uiListeners.length>0')||undefined);
 await evaluate(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'打开知乎，找一篇有评论的文章',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3（最新·多模态）'}]}});`);

 const check=async(name:string,expression:string)=>{const ok=!!await evaluate(expression);report.clicks.push({name,ok});if(!ok)throw Error(name);};
 const shot=async(name:string)=>{const image=await cdp!.send('Page.captureScreenshot',{format:'png'},sid);await writeFile(join(out,name+'.png'),Buffer.from(image.data,'base64'));};
 const emit=async(event:unknown)=>evaluate(`uiEmit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:${JSON.stringify(event)}}})`);
 const status=async(state:string)=>evaluate(`uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:${JSON.stringify(state)}}})`);
 await evaluate(`(()=>{const request=uiMessages.find(m=>m.kind==='client'&&m.msg.type==='conversation_create');if(request)uiEmit({kind:'server',msg:{type:'conversation_created',requestId:request.msg.requestId,conversation:{id:'default',title:'理解当前文章',createdAt:1,updatedAt:1,state:'idle',mode:'act'}}});const input=document.querySelector('#input');input.value='读一下这篇文章，总结主要观点。';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await click('#send-btn');await evaluate(`uiEmit({kind:'history',entries:[{seq:1,occurredAt:Date.now(),item:{kind:'user',text:'读一下这篇文章，总结主要观点。'}}]})`);await status('running');await emit({kind:'agent_start'});
 await emit({kind:'thinking_delta',delta:'先读取当前文章，再核对主要观点。'});
 await check('main orb preserved and process collapsed',`!!document.querySelector('.run-icon canvas')&&!document.querySelector('details.run-steps').open`);
 await check('paper background is flat',`getComputedStyle(document.body).backgroundImage==='none'`);
 await check('paired logo loads',`document.querySelector('#logo').complete&&document.querySelector('#logo').naturalWidth>0&&document.querySelector('#logo').src.endsWith('brand-mark.svg')`);
 await shot('01-thinking');
 await emit({kind:'tool_start',toolCallId:'read-1',name:'snapshot',params:{}});
 await shot('02-executing');
 await click('details.run-steps > summary');await click('.chip');
 await check('tool detail accessible',`document.querySelector('.chip').getAttribute('aria-expanded')==='true'&&!document.querySelector('.chip-detail').hidden`);
 await emit({kind:'tool_end',toolCallId:'read-1',name:'snapshot',isError:false,resultText:'文章：让工具服务于人的判断。'});
 await check('tool result updates open detail',`document.querySelector('.chip-detail').textContent.includes('服务于人的判断')`);
 await evaluate(`uiEmit({kind:'server',msg:{type:'agent_event',conversationId:'default',sessionId:'worker-1',event:{kind:'worker_task',task:'核对引用',output:'原文出处'}}})`);
 await check('collaborator task rows live inside process',`!!document.querySelector('.run-body .run-collaboration .collaboration-member')&&document.querySelector('.run-body .run-collaboration').textContent.includes('核对引用')`);
 await shot('03-process');
 await status('user');await check('takeover marked, not completed',`document.querySelector('.run-orb-mark').dataset.state==='user'`);await shot('04-takeover');
 await status('running');await emit({kind:'text_delta',delta:'这篇文章强调：**好的工具应该帮助人判断，而不是替人决定。**\n\n它提出三个重点：\n\n- 看清当前进展。\n- 随时调整方向。\n- 对未完成或不确定的结果明确说明。\n\n[查看原文](https://example.test/article)'});
 await emit({kind:'agent_end'});await status('idle');
 await check('answer remains separate from collapsed process',`!!document.querySelector('.msg.assistant.markdown a')&&!document.querySelector('details.run-steps').open&&!document.querySelector('.run-body .msg.assistant')`);
 await check('completed marker preserved',`document.querySelector('.run-orb-mark').dataset.state==='completed'`);
 if(process.argv.includes('--motion')) {
  await sleep(300);
  const closedHeight=await evaluate(`document.querySelector('details.run-steps').getBoundingClientRect().height`);
  await evaluate(`document.querySelector('details.run-steps').open=true`);await sleep(70);
  const middleHeight=await evaluate(`document.querySelector('details.run-steps').getBoundingClientRect().height`);
  await sleep(300);
  const expandedHeight=await evaluate(`document.querySelector('details.run-steps').getBoundingClientRect().height`);
  console.log({closedHeight,middleHeight,expandedHeight});
  await check('process opening interpolates actual height',`${middleHeight}>${closedHeight}&&${middleHeight}<${expandedHeight}`);
  await evaluate(`const d=document.querySelector('details.run-steps');d.open=false;d.open=true;d.open=false`);await sleep(300);
  await check('rapid process toggles settle closed',`!document.querySelector('details.run-steps').open&&getComputedStyle(document.querySelector('details.run-steps'),'::details-content').contentVisibility==='hidden'`);
 }
 await shot('05-answer');
 if(process.argv.includes('--reading-priority')){
  await check('reading typography matches chosen variant',`getComputedStyle(document.querySelector('.msg.assistant')).lineHeight==='27px'`);
  await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.copiedAnswer=text;}}})`);
  await click('.answer-actions button');
  await check('copy contains answer but no action labels',`copiedAnswer.includes('帮助人判断')&&!copiedAnswer.includes('复制回答')&&document.querySelector('.answer-action-feedback').textContent==='已复制'`);
  await evaluate(`document.querySelector('#input').value='保留这份未发送草稿'`);
  await click('.answer-actions button:nth-child(2)');
  await check('followup focuses composer without replacing draft',`document.activeElement===document.querySelector('#input')&&document.querySelector('#input').value==='保留这份未发送草稿'`);
  await evaluate(`document.querySelector('#input').value='';navigator.clipboard.writeText=async()=>{throw Error('denied')}`);
  await click('.answer-actions button');
  await check('clipboard failure is visible and retry available',`document.querySelector('.answer-action-feedback').textContent.includes('复制失败')&&!document.querySelector('.answer-actions button').disabled`);
  await evaluate(`document.querySelector('.answer-action-feedback').textContent=''`);
  await check('source link preserved',`document.querySelector('.msg.assistant a').href==='https://example.test/article'`);
  await evaluate(`document.documentElement.style.setProperty('--reading-size','17px');document.documentElement.style.setProperty('--reading-font','sans-serif')`);
  await check('reading preference retained while actions stay quiet',`getComputedStyle(document.querySelector('.msg.assistant')).fontSize==='17px'&&getComputedStyle(document.querySelector('.answer-actions')).fontSize==='12px'`);
  await evaluate(`document.documentElement.style.removeProperty('--reading-size');document.documentElement.style.removeProperty('--reading-font')`);
  await shot('07-reading-priority');
  await emit({kind:'user_delivery_stream',stream:{id:'reading-reply',runId:null,kind:'reply',text:'正在整理',phase:'streaming'}});
  await check('streamed delivery has no premature actions',`!document.querySelector('[data-delivery-id="reading-reply"] .answer-actions')`);
  const delivery={conversationId:'default',id:'reading-reply',runId:null,kind:'reply',text:'回答已整理完成。',composedAt:Date.now(),status:'composed'};
  await emit({kind:'user_delivery',delivery});
  await emit({kind:'user_delivery',delivery:{...delivery,status:'played'}});
  await check('final delivery and repeated receipt keep one action row',`document.querySelectorAll('[data-delivery-id="reading-reply"] .answer-actions').length===1`);
  await emit({kind:'user_delivery',delivery:{...delivery,id:'reading-ack',kind:'ack',text:'开始读取文章。'}});
  await check('acknowledgement stays quiet',`!document.querySelector('[data-delivery-id="reading-ack"] .answer-actions')`);
 }
 // Long answers should scroll inside the sidebar without stealing an earlier reading position.
 await status('running');await emit({kind:'agent_start'});await emit({kind:'thinking_delta',delta:'正在整理补充说明。'});
 await emit({kind:'text_delta',delta:'补充说明。\n\n'.repeat(80)});
 await evaluate(`document.querySelector('#messages').scrollTop=0`);await sleep(120);
 await emit({kind:'text_delta',delta:'最后补充一段。'});
 await check('streaming respects scroll position',`document.querySelector('#messages').scrollTop===0`);
 await emit({kind:'run_stopped'});await status('idle');
 await check('stop is not completion',`[...document.querySelectorAll('.run-orb-mark')].at(-1).dataset.state==='stopped'`);
 await status('running');await emit({kind:'agent_start'});await emit({kind:'thinking_delta',delta:'准备读取页面。'});await emit({kind:'error',message:'页面已关闭，请重新选择页面。'});await emit({kind:'agent_end'});await status('idle');
 await check('failure marker and message retained',`[...document.querySelectorAll('.run-orb-mark')].at(-1).dataset.state==='failed'&&document.body.textContent.includes('页面已关闭')`);
 for(const width of [320,400,520]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false},sid);
  await check(`width ${width} no overflow`,`document.documentElement.scrollWidth<=innerWidth`);
 }
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:850,deviceScaleFactor:1,mobile:false},sid);
 await evaluate(`document.querySelector('#messages').scrollTop=document.querySelector('#messages').scrollHeight`);
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},sid);await shot('06-dark');
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sid);
 await check('reduced motion removes message entrance',`getComputedStyle(document.querySelector('.msg')).animationName==='none'`);

 if(process.argv.includes('--composer')) {
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},sid);
  await evaluate(`document.querySelector('#messages').replaceChildren()`);
  const base={conversationId:'default',source:'text',action:'start',runId:'run-a',text:'原任务',targetTitle:'当前任务',status:'accepted',message:'已接收',updatedAt:Date.now()};
  for(const requestId of ['a1','a2','a3'])await emit({kind:'notice',message:'已接收',receipt:{...base,requestId,runId:requestId==='a3'?'run-b':'run-a'}});
  await emit({kind:'notice',message:'更新',receipt:{...base,requestId:'a1',message:'已接收，正在执行'}});
  await emit({kind:'notice',message:'排队',receipt:{...base,requestId:'queue-transition',status:'queued'}});
  await emit({kind:'notice',message:'接收',receipt:{...base,requestId:'queue-transition',status:'accepted'}});
  await check('queued receipt moves into archive after acceptance',`!!document.querySelector('.receipt-archive [data-request-id="queue-transition"]')`);
  await check('ordinary receipts folded with identity retained',`document.querySelectorAll('.receipt-archive').length===1&&document.querySelectorAll('.receipt-archive .receipt').length===4&&document.querySelectorAll('.receipt-run').length===2&&!document.querySelector('.receipt-archive').open`);
  await emit({kind:'notice',message:'失败',receipt:{...base,requestId:'a1',status:'failed',message:'执行失败'}});
  await check('failure update exits archive',`!!document.querySelector('#messages > .receipt.notice')`);
  await check('diagnostics hidden by default',`document.querySelector('.voice-record').hidden`);
  await click('#composer-more');await click('#voice-diagnostics-open');
  await check('diagnostics available on demand',`!document.querySelector('.voice-record').hidden&&document.querySelector('.voice-diag').open`);
  await click('#composer-more');await click('#voice-diagnostics-open');
  const original={requestId:'fork-source',conversationId:'default',source:'voice',action:'start',expectedRunId:'run-a',text:'核对这张图',context:{tabId:42,title:'原文章',url:'https://example.test/original',selection:{text:'选中内容'}},attachments:[{id:'image1',name:'参考.png',type:'image',mimeType:'image/png',dataBase64:'aGVsbG8='}]};
  await emit({kind:'notice',message:'另开会话',receipt:{...base,requestId:'fork-source',status:'rejected',text:original.text,message:'当前任务还在执行。要另开会话处理这个新任务吗？',newConversationRequest:original}});
  await evaluate(`document.querySelector('#messages').scrollTop=document.querySelector('#messages').scrollHeight`);await sleep(150);
  await evaluate(`uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'opencode-go/deepseek-flash',models:[{id:'opencode-go/deepseek-flash',provider:'opencode-go',modelId:'deepseek-flash',name:'DeepSeek V4.1 Flash'}]}})`);
  await check('model stays visible as lightweight text',`!document.querySelector('#model-btn').hidden&&getComputedStyle(document.querySelector('#model-btn')).borderTopWidth==='0px'`);
  await shot('08-composer-cleanup');
  await evaluate(`globalThis.beforeFork=uiMessages.length;const b=document.querySelector('.receipt-decision button');b.click();b.click()`);
  await check('double click creates one conversation',`uiMessages.slice(beforeFork).filter(m=>m.msg?.type==='conversation_create').length===1`);
  await evaluate(`(()=>{const m=uiMessages.slice(beforeFork).find(m=>m.msg?.type==='conversation_create').msg;uiEmit({kind:'server',msg:{type:'conversation_created',requestId:m.requestId,conversation:{id:'fork-destination',title:'新会话',createdAt:1,updatedAt:1,state:'idle',mode:'act'}}})})()`);
  await check('fork preserves input and targets new conversation',`(()=>{const m=uiMessages.slice(beforeFork).find(m=>m.msg?.type==='task_action').msg;return m.conversationId==='fork-destination'&&m.request.conversationId==='fork-destination'&&m.request.text==='核对这张图'&&m.request.context.tabId===42&&m.request.context.selection.text==='选中内容'&&m.request.attachments[0].dataBase64==='aGVsbG8='&&m.request.expectedRunId===null&&m.request.forkedFrom.requestId==='fork-source'})()`);
 }
 report.ok=report.clicks.every((c:any)=>c.ok)&&!report.errors.length;if(!report.ok)process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.clicks,error:report.error,errors:report.errors}));
}
