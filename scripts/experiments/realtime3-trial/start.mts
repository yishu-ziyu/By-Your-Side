// Independent, disposable browser + real product host. Never patches the daily extension/config.
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,cp,readFile,writeFile,chmod} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {build} from 'esbuild';
import {createCdp,fetchJson} from '../../acceptance/cdp.mjs';
import {RealtimeVoiceConnection as TrialVoiceSession} from '../../../agent/src/realtime-voice-connection.js';

const headless=process.argv.includes('--headless');

if(!headless&&!process.argv.includes('--visible')) throw new Error('Explicit --visible or --headless required');

const key=process.env.STEPFUN_API_KEY;

if(!key) throw new Error('STEPFUN_API_KEY is missing; no credential was read from another project');

const out=resolve(process.argv[process.argv.indexOf('--out')+1] && process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out')+1]! : `out/experiments/realtime3-${Date.now()}`);

await mkdir(out,{recursive:true,mode:0o700});

 await chmod(out,0o700);

let previousReady:any;

try{previousReady=JSON.parse(await readFile(join(out,'ready.json'),'utf8'));}catch{}

if(previousReady?.out===out)await writeFile(join(out,`ready-history-${previousReady.pid}.json`),JSON.stringify(previousReady,null,2),{mode:0o600});

await writeFile(join(out,'ready.json'),JSON.stringify({pid:process.pid,out,ready:false,phase:'starting',...(previousReady?.out===out?{extensionId:previousReady.extensionId}:{})}),{mode:0o600});

process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');

const chrome=process.env.EGO_ACCEPTANCE_CHROME ?? resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

process.env.EGO_ACCEPTANCE_CHROME=chrome;

const {startHost,stopHost}=await import('../../acceptance/product-journeys/runner.mjs');

const {loadConfig}=await import('../../../agent/src/config.js');

const {sanitizeTrace}=await import('../../../agent/src/run-trace.js');

const events: Array<{at:number;direction:string;message:Record<string,unknown>}>=[];

const host=await startHost(loadConfig().model ?? '',join(out,'store'),events);

const token=randomUUID();

let browser:ChildProcess|undefined, cdp:ReturnType<typeof createCdp>|undefined,swSession:string|undefined,extensionId='';

let voice:TrialVoiceSession|undefined,voiceClient:WebSocket|undefined,voiceTurn=0,closing=false;

const log=(event:Record<string,unknown>)=>appendFileSync(join(out,'events.jsonl'),JSON.stringify(sanitizeTrace({at:Date.now(),...event})).replaceAll(key,'[redacted]')+'\n',{mode:0o600});

const http=createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:!!swSession&&host.socket?.readyState===WebSocket.OPEN,model:'stepaudio-3-realtime-preview',headless,hostConnected:host.socket?.readyState===WebSocket.OPEN}));

return;}

  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Realtime 3 试用 · 阅读材料</title><style>body{font:18px/1.8 system-ui;max-width:760px;margin:60px auto;padding:24px;background:#faf9f6;color:#252823}h1{line-height:1.3}aside{font-size:14px;padding:16px;background:#e8eee5;border-radius:12px}</style><aside>这是隔离验收浏览器；日常语音已统一为 Realtime 3，本入口不替代日常侧栏。右侧试用栏点「开始交谈」后才开启麦克风。可以打开自己的网页，试阅读、翻译和显示调整；提交、付款与任意脚本暂不执行。原始音频不会保存。</aside><main><h1>Small Gardens, Shared Discoveries</h1><p>A small community garden can change the rhythm of a neighbourhood. People who once passed each other without a word begin comparing tomatoes, sharing tools and noticing when a neighbour needs help.</p><p>The most successful gardens do not start with a perfect plan. They start with a few people, a patch of soil, and a willingness to learn together. Some plants thrive while others fail, but each season leaves the community with better questions.</p><p>Water is the first practical challenge. Collecting rainwater can reduce waste, while a simple watering schedule helps volunteers share the work fairly. Good paths and raised beds make the garden welcoming to people with different abilities.</p><p>A garden is not only a place for growing food. It is also a place for conversation, patience and small discoveries. Its value becomes visible over time, one shared harvest at a time.</p></main></html>`);
});

await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));

const port=(http.address() as {port:number}).port;

const wss=new WebSocketServer({server:http,maxPayload:1024*1024});

const swEval=async(expression:string)=>{
  if(!cdp||!swSession) throw new Error('试用扩展尚未就绪');
  const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},swSession);

  if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);

  return r.result?.value;
};

async function page(){
  const tab=await swEval(`chrome.tabs.query({active:true,lastFocusedWindow:true}).then(ts=>ts.find(t=>/^https?:/.test(t.url||'')))`);

  if(!tab?.id) throw new Error('请先在试用浏览器打开一个网页，再使用侧栏。');

  return {tabId:tab.id as number,title:String(tab.title??''),url:String(tab.url??'')};
}

// Deliberately conservative host-level allowlist: no arbitrary JS, submit, click, typing or network writes.
export function allowedTool(name:string,params:Record<string,unknown>):boolean{
  if(['snapshot','read_element','screenshot','scroll','hover','mark','take_tab','get_active_tab','list_tabs','switch_tab','worker_tabs','share_tab','observe_page','clear_marks'].includes(name)) return true;

  if(name==='page_translation') return ['begin','collect','apply','display','restore'].includes(String(params.action));

  if(name==='tabs') return ['list','active','switch'].includes(String(params.action));

  return false;
}

host.wss.on('connection',client=>{
  log({type:'task_socket_open'});
  client.on('message',raw=>{try{const m=JSON.parse(String(raw));

if(m.type==='hello')log({type:'task_hello',tokenAccepted:m.token===host.token});}catch{}});
  client.on('close',(code)=>log({type:'task_socket_closed',code}));
  const original=client.send.bind(client);
  (client as any).send=(data:any,...args:any[])=>{
    let m:any;

 try{m=JSON.parse(String(data));}catch{return (original as any)(data,...args);}

    if(m.type==='tool_call'&&!allowedTool(m.name,m.params??{})){
      log({type:'trial_tool_blocked',name:m.name,id:m.id,conversationId:m.conversationId});
      queueMicrotask(()=>void host.manager.handleMessage({type:'tool_result',conversationId:m.conversationId,id:m.id,ok:false,error:'独立试用安全限制：这个操作未执行。当前只开放阅读、翻译和显示调整；提交、付款、表单写入和任意脚本不开放，不要改换工具绕过。',executionFact:'not_executed'}));

      return;
    }

    if(m.type==='agent_event'&&m.event?.kind==='user_delivery'){
      const delivery=m.event.delivery;
      log({type:'task_delivery',conversationId:m.conversationId,delivery});

      if(delivery.kind!=='ack'&&typeof delivery.text==='string') voice?.notifyTask(delivery.text);
    }

    return (original as any)(data,...args);
  };
});

wss.on('connection',(client,req)=>{
  if(req.url!=='/voice'||req.headers.origin!==`chrome-extension://${extensionId}`){client.close(1008,'origin rejected');

return;}

  let authenticated=false;
  const timer=setTimeout(()=>client.close(1008,'auth timeout'),3000);
  client.on('message',raw=>{
    let message:Record<string,unknown>;

try{message=JSON.parse(String(raw));}catch{client.close(1008,'invalid frame');

return;}

    if(!authenticated){
      if(message.type!=='auth'||message.token!==token||voiceClient?.readyState===WebSocket.OPEN){client.close(1008,'auth rejected or another call active');

return;}

      authenticated=true;clearTimeout(timer);voiceClient=client;

      const session=new TrialVoiceSession({key,send:event=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(event));},log,tools:{
        read_page:async()=>{const context=await page();const text=await swEval(`chrome.scripting.executeScript({target:{tabId:${context.tabId}},func:()=>({text:document.body.innerText.slice(0,18000),selection:getSelection()?.toString().slice(0,5000)||''})}).then(r=>r[0]?.result)`);

return {context,...text};},
        task_status:async()=>({tasks:host.manager.list().map(c=>({id:c.id,title:c.title,progress:host.manager.getTaskProgress(c.id)}))}),
        browser_request:async text=>{
          const context=await page();
          const selected=await swEval(`chrome.storage.session.get('selectedConversationId').then(x=>x.selectedConversationId||'default')`);
          const id=typeof selected==='string'&&host.manager.get(selected)?selected:'default';
          const progress=host.manager.getTaskProgress(id);
          log({type:'voice_task_request',text,conversationId:id,tabId:context.tabId});

          return host.manager.routeVoiceInput(id,text,progress?.startedAt??null,()=>voice===session,{requestId:randomUUID(),runId:progress?.runId??null,voiceId:'realtime3-trial',turn:++voiceTurn,input:{context}});
        }
      }});

      voice=session;session.start();

return;
    }

    if(voiceClient===client) voice?.handle(message);
  });
  client.on('close',()=>{clearTimeout(timer);

if(voiceClient===client){voice?.close();voice=undefined;voiceClient=undefined;}});
});

async function until<T>(fn:()=>Promise<T|undefined>,label:string,ms=20000):Promise<T>{const end=Date.now()+ms;

while(Date.now()<end){try{const x=await fn();

if(x!==undefined&&x!==false)return x;}catch{}

await new Promise(r=>setTimeout(r,150));}

throw new Error(`等待超时：${label}`);}

async function shutdown(exitCode=0){if(closing)return;closing=true;voice?.close();

for(const c of wss.clients)c.terminate();await stopHost(host).catch(()=>{});browser?.kill('SIGTERM');await cdp?.close().catch(()=>{});http.close();wss.close();await writeFile(join(out,'stopped.json'),JSON.stringify({at:Date.now(),pid:process.pid,exitCode}));let last:any;

try{last=JSON.parse(await readFile(join(out,'ready.json'),'utf8'));}catch{}

await writeFile(join(out,'ready.json'),JSON.stringify({...last,pid:process.pid,out,ready:false,phase:exitCode?'failed':'stopped'}),{mode:0o600});setTimeout(()=>process.exit(exitCode),300).unref();}

process.on('SIGTERM',()=>void shutdown());

process.on('SIGINT',()=>void shutdown());

try{
  const ext=join(out,'extension');await cp(resolve('extension/dist'),ext,{recursive:true});
  // Extension resources are cached across profile reuse. Fresh entry URLs bind all runtime ports
  // to this launch while the extension directory/id (and microphone permission) remain unchanged.
  const buildId=randomUUID().slice(0,8);
  const panelFile=`trial-panel-${buildId}.html`,backgroundFile=`background-${buildId}.js`;
  const uiFile=`trial-ui-${buildId}.js`,configFile=`trial-config-${buildId}.js`,cssFile=`trial-ui-${buildId}.css`,workletFile=`trial-capture-${buildId}.js`;
  const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));delete manifest.key;manifest.name='By Your Side · Realtime 3 试用';manifest.permissions=manifest.permissions.filter((p:string)=>p!=='nativeMessaging');manifest.background.service_worker=backgroundFile;manifest.side_panel.default_path=panelFile;await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest,null,2));
  let background=await readFile(join(ext,'background.js'),'utf8');

  if(!background.includes('var DEFAULT_PORT = 7758;'))throw new Error('无法安全定位独立端口，拒绝启动');
  background=background.replace('var DEFAULT_PORT = 7758;',`var DEFAULT_PORT = ${host.port};`);await writeFile(join(ext,backgroundFile),background);
  await build({entryPoints:[resolve('scripts/experiments/realtime3-trial/ui.ts')],bundle:true,format:'iife',outfile:join(ext,uiFile)});
  await cp(resolve('scripts/experiments/realtime3-trial/ui.css'),join(ext,cssFile));
  await writeFile(join(ext,configFile),`globalThis.__REALTIME3_TRIAL__=${JSON.stringify({url:`ws://127.0.0.1:${port}/voice`,token,workletUrl:workletFile})};`,{mode:0o600});
  const uiSource=await readFile(resolve('scripts/experiments/realtime3-trial/ui.ts'),'utf8');
  const worklet=uiSource.match(/export const REALTIME3_CAPTURE_WORKLET_SOURCE = `([\s\S]*?)`;/)?.[1];

  if(!worklet)throw new Error('未能提取音频采集工作线程');await writeFile(join(ext,workletFile),worklet);
  const html=await readFile(join(ext,'sidepanel.html'),'utf8');await writeFile(join(ext,panelFile),html.replace('</head>',`<link rel="stylesheet" href="${cssFile}"></head>`).replace('</body>',`<script src="${configFile}"></script><script src="${uiFile}"></script></body>`));
  await writeFile(join(ext,'trial-open.html'),`<!doctype html><meta charset="utf-8"><title>打开 Realtime 3 试用</title><button id="open" style="margin:40px;padding:20px;font:20px system-ui" disabled>打开独立试用侧栏</button><p id="status"></p><script type="module" src="trial-open.js"></script>`);
  await writeFile(join(ext,'trial-open.js'),`const tab=await chrome.tabs.getCurrent();const button=document.querySelector('#open');button.disabled=false;button.onclick=()=>{chrome.sidePanel.open({windowId:tab.windowId}).then(()=>chrome.tabs.remove(tab.id)).catch(e=>document.querySelector('#status').textContent=e.message);};`);
  const profile=join(out,'profile');
  const args=[...(headless?['--headless=new','--mute-audio']:[]),`--user-data-dir=${profile}`,'--remote-debugging-port=0','--enable-unsafe-extension-debugging',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check','--window-size=1320,900',`http://127.0.0.1:${port}/`];
  browser=spawn(chrome,args,{stdio:'ignore',env:{...process.env,STEPFUN_API_KEY:undefined,SIDEAGENT_STEP_PLAN_KEY:undefined,TYPESAFE_API_KEY:undefined}});browser.once('error',err=>{log({type:'browser_error',message:err.message});void shutdown();});browser.once('exit',()=>void shutdown());

  // Reused profiles retain DevToolsActivePort from the previous process; wait for a live endpoint.
  const debuggerInfo=await until(async()=>{const raw=await readFile(join(profile,'DevToolsActivePort'),'utf8');const debugPort=raw.split('\n')[0];const version=await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);

return {debugPort,version};},'独立浏览器');

  const {debugPort,version}=debuggerInfo;cdp=createCdp(version.webSocketDebuggerUrl);await cdp.ready();
  // An installed unpacked extension keeps its registered worker across browser restarts.
  // Reload only this profile's previously recorded trial extension after rebuilding its files.
  const previous=previousReady;

  if(previous?.out===out&&/^[a-p]{32}$/.test(previous.extensionId??'')){
    const management=await cdp.send('Target.createTarget',{url:'chrome://extensions/'});
    const managementSession=await cdp.attachSession(management.targetId);
    await until(async()=>{const r=await cdp!.send('Runtime.evaluate',{expression:`!!globalThis.chrome?.developerPrivate?.reload`,returnByValue:true},managementSession);

return r.result?.value||undefined;},'试用扩展重载入口');
    const reloaded=await cdp.send('Runtime.evaluate',{expression:`(async()=>{await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});await new Promise((resolve,reject)=>chrome.developerPrivate.reload(${JSON.stringify(previous.extensionId)},{failQuietly:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)));await chrome.management.setEnabled(${JSON.stringify(previous.extensionId)},true);return true})()`,awaitPromise:true,returnByValue:true,userGesture:true},managementSession);

    if(reloaded.exceptionDetails)throw new Error('试用扩展重载失败：'+reloaded.exceptionDetails.text);
    log({type:'trial_extension_reloaded',extensionId:previous.extensionId,buildId});
    await cdp.send('Target.closeTarget',{targetId:management.targetId});
  }

  const sw=await until(async()=>{
    const {targetInfos}=await cdp!.send('Target.getTargets');

    for(const target of targetInfos.filter((t:any)=>t.type==='service_worker'&&t.url.startsWith('chrome-extension:'))){
      const session=await cdp!.attachSession(target.targetId);
      const probe=await cdp!.send('Runtime.evaluate',{expression:`typeof chrome!=='undefined'&&chrome.runtime?.getManifest?.().name`,returnByValue:true},session);

      if(probe.result?.value===manifest.name)return {target,session};
      log({type:'worker_probe',url:target.url,name:probe.result?.value,error:probe.exceptionDetails?.exception?.description});
    }
  },'独立扩展');

  extensionId=new URL(sw.target.url).host;swSession=sw.session;
  await until(async()=>await swEval(`typeof chrome!=='undefined'&&!!chrome.storage?.local&&!!chrome.tabs?.query`)||undefined,'扩展 API 就绪');
  await swEval(`globalThis.__trialConnections=[];globalThis.WebSocket=class extends WebSocket{constructor(url,protocols){super(url,protocols);const record={url:String(url)};__trialConnections.push(record);this.addEventListener('open',()=>record.open=true);this.addEventListener('close',e=>record.closeCode=e.code);}};`);
  await swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(host.token)}})`);
  let panelId:string;

  if(headless){panelId=(await cdp.send('Target.createTarget',{url:`chrome-extension://${extensionId}/${panelFile}`})).targetId;}
  else{
    // sidePanel.open requires a real extension-page gesture, not Runtime.evaluate on the SW.
    const opener=await cdp.send('Target.createTarget',{url:`chrome-extension://${extensionId}/trial-open.html`});
    const openerSession=await cdp.attachSession(opener.targetId);

    const point=await until(async()=>{const r=await cdp!.send('Runtime.evaluate',{expression:`(()=>{const b=document.querySelector('#open');if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,returnByValue:true},openerSession);

return r.result?.value??undefined;},'打开按钮');

    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1},openerSession);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1},openerSession);
    panelId=(await until(async()=>{const {targetInfos}=await cdp!.send('Target.getTargets');

return targetInfos.find((t:any)=>t.url===`chrome-extension://${extensionId}/${panelFile}`);},'试用侧栏')).targetId;
  }

  const panelSession=await cdp.attachSession(panelId);
  await until(async()=>{const r=await cdp!.send('Runtime.evaluate',{expression:'!!globalThis.__r3Trial',returnByValue:true},panelSession);

return r.result?.value||undefined;},'语音试用控件');
  await cdp.send('Runtime.evaluate',{expression:`window.__trialPort=chrome.runtime.connect({name:'sideagent-panel'});__trialPort.postMessage({kind:'retry'});`},panelSession);
  await until(async()=>host.socket?.readyState===WebSocket.OPEN?true:undefined,'实际任务引擎');
  const info={pid:process.pid,browserPid:browser.pid,out,headless,extensionId,panelFile,buildId,panelId,panelSession,debugPort:Number(debugPort),url:`http://127.0.0.1:${port}/`,hostPort:host.port,voicePort:port,model:'stepaudio-3-realtime-preview',taskModel:host.manager.get('default')!.runtime.session.modelName(),ready:true,startedAt:Date.now()};
  await writeFile(join(out,'ready.json'),JSON.stringify(info,null,2),{mode:0o600});
  console.log(JSON.stringify(info));
  log({type:'trial_ready',headless,model:info.model,taskModel:info.taskModel});
}catch(error){if(cdp)try{const t=await cdp.send('Target.createTarget',{url:'chrome://extensions/'});const s=await cdp.attachSession(t.targetId);await until(async()=>{const r=await cdp!.send('Runtime.evaluate',{expression:'!!globalThis.chrome?.developerPrivate?.getExtensionsInfo',returnByValue:true},s);

return r.result?.value||undefined;},'扩展错误读取',3000);const r=await cdp.send('Runtime.evaluate',{expression:`chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(xs=>xs.filter(x=>x.name.includes('Realtime')).map(x=>({id:x.id,state:x.state,disableReasons:x.disableReasons,manifestErrors:x.manifestErrors,runtimeErrors:x.runtimeErrors})))`,returnByValue:true,awaitPromise:true},s);log({type:'extension_startup_errors',details:r.result?.value});}catch{}

if(swSession)try{log({type:'startup_connection_diagnostic',expectedPort:host.port,connections:await swEval('globalThis.__trialConnections')});}catch{}

log({type:'startup_failed',message:String(error)});console.error(String(error).replaceAll(key,'[redacted]'));process.exitCode=1;await shutdown(1);}
