/** Visible local speech-model check in the user's Chrome. No microphone or upstream service. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCdp} from './cdp.mjs';
const out=await mkdtemp(join(tmpdir(),'ego-speech-detection-'));
const samples:any[]=[];
for(const [name,text,gain] of [['中文短句','帮我列出当前标签页',1],['轻声短句','帮我列出当前标签页',.12],['嗯','嗯',1],['对','对',1],['停','停',1]] as const){
 const stem=join(out,String(samples.length));execFileSync('/usr/bin/say',['-v','Tingting','-r','180','-o',stem+'.aiff',text]);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',stem+'.aiff','-ar','24000','-ac','1','-f','s16le',stem+'.pcm']);
 const original=await readFile(stem+'.pcm'),pcm=Buffer.alloc(24000+original.length+48000);
 for(let i=0;i<original.length;i+=2)pcm.writeInt16LE(Math.round(original.readInt16LE(i)*gain),24000+i);
 const id=samples.length;await writeFile(join(out,id+'.pcm'),pcm);samples.push({id,name,expected:1});
}
let seed=42;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1};
for(const name of ['静音','100ms噪声','连续白噪声','短冲击声']){
 const pcm=Buffer.alloc(48000*4);
 for(let i=0;i<pcm.length/2;i++){const t=i/24000;let x=0;if(name==='100ms噪声'&&t>=.5&&t<.6)x=random()*.04;if(name==='连续白噪声')x=random()*.04;if(name==='短冲击声'&&i%12000<120)x=random()*.4;pcm.writeInt16LE(Math.round(x*32767),i*2)}
 const id=samples.length;await writeFile(join(out,id+'.pcm'),pcm);samples.push({id,name,expected:0});
}
await build({stdin:{resolveDir:process.cwd(),contents:`
import {SpeechClassifier} from './extension/src/sidepanel/voice-speech.ts';
import {VoiceTurnDetector} from './extension/src/sidepanel/voice-signal.ts';
globalThis.chrome ??= {runtime:{getURL:p=>new URL(p,location.href).href}};
globalThis.results=[];
const samples=${JSON.stringify(samples)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const sample of samples){
 const li=document.createElement('li');li.textContent=sample.name+'：检测中';document.querySelector('ul').append(li);
 let starts=0,commits=0,maxProbability=0,frames=0;let nextFrame;const d=new VoiceTurnDetector({start:()=>starts++,audio:()=>{},end:()=>commits++});
 const c=await SpeechClassifier.create((pcm,p)=>{frames++;maxProbability=Math.max(maxProbability,p);d.push(pcm,p);nextFrame?.()},()=>{throw Error('classifier failure')});
 const pcm=new Int16Array(await (await fetch(globalThis.sampleBase+'/'+sample.id+'.pcm')).arrayBuffer());
 for(let i=0;i+768<=pcm.length;i+=768){await new Promise(resolve=>{nextFrame=resolve;c.push(pcm.slice(i,i+768))})}
 const deadline=Date.now()+3000;while(frames<Math.floor(pcm.length/768)&&Date.now()<deadline)await sleep(20);
 c.close();const result={...sample,starts,commits,maxProbability,frames,expectedFrames:Math.floor(pcm.length/768),ok:starts===sample.expected&&commits===sample.expected&&frames===Math.floor(pcm.length/768)};
 results.push(result);li.textContent=sample.name+'：'+(result.ok?'通过':'未通过')+' · 触发 '+starts+' 次，提交 '+commits+' 次';
}
globalThis.done=true;document.querySelector('p').textContent='本地样本检查完成。实际麦克风体验仍由你试用判断。';
`},bundle:true,format:'esm',outfile:join(out,'check.js')});
const server=createServer(async(req,res)=>{const p=new URL(req.url!,'http://local').pathname;try{
 if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><title>By Your Side · 人声检测实测</title><style>body{font:18px/2 system-ui;max-width:850px;margin:50px auto;padding:20px}li{margin:12px 0}</style><h1>人声检测实测</h1><p>正在使用本地模型检测合成中文和噪声样本，不使用你的麦克风。</p><ul></ul><script type="module" src="check.js"></script>');return}
 const file=resolve(p==='/check.js'||p.endsWith('.pcm')?out:'extension/dist','.'+p);if(!file.startsWith(resolve(out)+'/')&&!file.startsWith(resolve('extension/dist')+'/'))throw Error('path');res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'} as any)[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch{res.statusCode=404;res.end()}});
server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+(server.address() as any).port;
const info=await fetch('http://127.0.0.1:9222/json/version').then(r=>r.json()) as any;const cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
try{
 const {targetInfos}=await cdp.send('Target.getTargets');
 const background=targetInfos.find((t:any)=>t.type==='service_worker'&&t.url==='chrome-extension://fnbjglhppbkgmjeehablkfilmmefjolo/background.js');
 if(!background)throw Error('Installed extension worker unavailable');
 const bg=await cdp.attachSession(background.targetId);
 const pagePath='voice-permission.html?speech-check='+Date.now();
 const pageUrl='chrome-extension://fnbjglhppbkgmjeehablkfilmmefjolo/'+pagePath;
 const created=await cdp.send('Runtime.evaluate',{expression:`chrome.tabs.create({url:chrome.runtime.getURL(${JSON.stringify(pagePath)})}).then(t=>t.id)`,awaitPromise:true,returnByValue:true},bg);
 let target:any;
 for(let i=0;i<30;i++){const list=await cdp.send('Target.getTargets');target=list.targetInfos.find((t:any)=>t.url===pageUrl);if(target)break;await new Promise(r=>setTimeout(r,100))}
 if(!target)throw Error('Native test tab unavailable');const t=target;const sid=await cdp.attachSession(t.targetId);
 await new Promise(r=>setTimeout(r,700));
 await cdp.send('Runtime.evaluate',{expression:`document.title='By Your Side · 人声检测实测';document.body.innerHTML='<h1>人声检测实测</h1><p>正在使用本地模型检测合成中文和噪声样本，不使用你的麦克风。</p><ul></ul>';globalThis.sampleBase=${JSON.stringify(url)};`,returnByValue:true},sid);
await cdp.send('Runtime.enable',{},sid);cdp.onEvent('Runtime.exceptionThrown',(e:any)=>{if(e.sessionId===sid)console.log('BROWSER ERROR',e.params.exceptionDetails.text,e.params.exceptionDetails.exception?.description)});console.log(JSON.stringify({out,url,target:t.targetId}));
 await cdp.send('Runtime.evaluate',{expression:'(async()=>{'+await readFile(join(out,'check.js'),'utf8')+'})().catch(e=>{globalThis.failure=String(e);document.querySelector(\'p\').textContent=String(e)})',returnByValue:true},sid);
 const deadline=Date.now()+100000;let done=false;while(Date.now()<deadline){const r=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({done:globalThis.done,failure:globalThis.failure,results:globalThis.results})',returnByValue:true},sid);const data=JSON.parse(r.result.value);if(data.failure)throw Error(data.failure);if(data.done){await writeFile(join(out,'results.json'),JSON.stringify(data,null,2));console.log(JSON.stringify(data));done=true;process.exitCode=data.results.every((r:any)=>r.ok)?0:1;break}await new Promise(r=>setTimeout(r,1000))}if(!done)throw Error('Visible speech check timed out');
}finally{await cdp.close();server.close();server.closeAllConnections()}
