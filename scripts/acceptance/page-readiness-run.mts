/** Real Chrome APIs and production tab tools, in an isolated headless profile. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createCdp} from './cdp.mjs';
const out=await mkdtemp(join(tmpdir(),'ego-page-readiness-'));
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const report:any={ok:false,checks:[],source:'production openTab/navigate in isolated headless Chrome, no user profile'};
let page=0;const server=createServer((req,res)=>{
 if(req.url==='/slow'){res.writeHead(200,{'Content-Type':'image/png'});res.write(Buffer.from([137,80,78,71]));return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Readiness ${++page}</title><h1>Document ${page}</h1><input id="value" value="ready"><img src="/slow">`);
});
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
const check=(name:string,ok:boolean)=>{report.checks.push({name,ok});if(!ok)throw Error(name);};
async function until<T>(fn:()=>Promise<T|undefined>,ms=20000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const result=await fn().catch(()=>undefined);if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error('startup timeout');}
try{
 await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated readiness test',version:'1.0',permissions:['tabs','tabGroups','storage','scripting'],host_permissions:['<all_urls>'],background:{service_worker:'background.js',type:'module'}}));
 await build({stdin:{contents:`import {openTab} from ${JSON.stringify(resolve('extension/src/background/exec/tabs.ts'))};import {navigate} from ${JSON.stringify(resolve('extension/src/background/exec/navigate.ts'))};globalThis.probe={openTab,navigate};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',outfile:join(ext,'background.js')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const chrome='/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
 child=spawn(chrome,['--headless=new','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{stdio:'ignore'});
 report.stage='debug-port';const port=await until(async()=>{const s=await readFile(join(profile,'DevToolsActivePort'),'utf8');return s.split('\n')[0];});
 const info=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json()) as any;cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 report.stage='extension-worker';const target=await until(async()=>{const r=await cdp!.send('Target.getTargets');report.targets=r.targetInfos.map((t:any)=>({type:t.type,url:t.url}));for(const t of r.targetInfos.filter((t:any)=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'))){const candidate=await cdp!.attachSession(t.targetId);const name=await cdp!.send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true},candidate);if(name.result?.value==='Isolated readiness test')return t;}return undefined;});
 const sid=await cdp.attachSession(target.targetId);
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sid);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 report.stage='probe-ready';await until(async()=>await evaluate('!!globalThis.probe')||undefined);
 report.open=await evaluate(`probe.openTab({url:${JSON.stringify(url)}})`);
 check('open returns an interactive document before the held image completes',report.open.readiness==='interactive');
 report.tab=await evaluate(`chrome.tabs.get(${report.open.tabId}).then(t=>({status:t.status,url:t.url}))`);
 check('Chrome still reports loading at tool return',report.tab.status==='loading');
 report.input=await evaluate(`chrome.scripting.executeScript({target:{tabId:${report.open.tabId}},injectImmediately:true,func:()=>document.querySelector('#value')?.value}).then(r=>r[0].result)`);
 check('the returned document contains the actual usable input',report.input==='ready');
 report.navigate=await evaluate(`probe.navigate({url:${JSON.stringify(url)},timeout:5})`);
 check('same URL navigation waits for a different document',report.navigate.documentId!==report.open.documentId&&report.navigate.readiness==='interactive');
 report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);report.browserExited=child.exitCode!==null||child.signalCode!==null;if(!report.browserExited){child.kill('SIGKILL');await exited;report.browserExited=true;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report}));
}
