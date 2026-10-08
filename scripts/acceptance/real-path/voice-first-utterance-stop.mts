/** 连接时说完第一句话后结束：迟到的真实就绪通知不能补发旧话。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, sleep, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const apiVoice=process.argv.includes('--api');
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-first-utterance-stop`);
await mkdir(out,{recursive:true});
const wav=join(out,'microphone.wav');
execFileSync('say',['-v','Tingting','-o',wav,'--data-format=LEI16@24000','[[slnc 300]]这个页面上的备注写的是什么[[slnc 1000]]']);
const raw=await readFile(wav), endMs=(raw.length-raw.indexOf('data')-8)/48-1000;
const key=(await readFile(join(homedir(),apiVoice?'.sideagent/stepfun-api.key':'.sideagent/step-plan.key'),'utf8')).trim();
const model=await startScriptedModel([]);
let rp:Awaited<ReturnType<typeof launchRealPath>>|undefined, error:string|null=null;
let evidence:Record<string,unknown>={};
try {
  rp=await launchRealPath({microphoneWav:wav});
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'},inproc_voice_key:key,inproc_voice_model:apiVoice?'stepaudio-3-realtime-preview':'stepaudio-2.5-realtime'})})`);
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.getAttribute("aria-busy")!=="true"'),30000,'assistant ready');
  const off=await rp.attach((await until(async()=>(await rp!.targets()).find(t=>t.url.endsWith('/inproc.html')),10000,'offscreen')).targetId);
  await rp.evaluate(off,`(()=>{window.__readyGates=[];window.__appends=0;const add=WebSocket.prototype.addEventListener,send=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data){if(JSON.parse(data).type==='input_audio_buffer.append')window.__appends++;return send.call(this,data);};
    WebSocket.prototype.addEventListener=function(type,listener,...rest){if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      return add.call(this,type,function(event){if(JSON.parse(event.data).type==='session.updated'){
        const gate={receivedAt:Date.now(),deliveredAt:null};window.__readyGates.push(gate);
        setTimeout(()=>{gate.deliveredAt=Date.now();listener.call(this,event);},4000);return;
      }return listener.call(this,event);},...rest);};return true;})()`);
  await rp.evaluate(panel,`(()=>{const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await get(...args);window.__micAt=Date.now();return stream;};return true;})()`);
  const requestsBefore=model.requests.length;
  await rp.click(panel,'.voice-start');
  await until(async()=>await rp!.evaluate(off,'window.__readyGates[0]?.receivedAt'),15000,'real ready received but held');
  const micAt=await rp.evaluate(panel,'window.__micAt') as number;
  await sleep(Math.max(0,micAt+endMs-Date.now()));
  const gate=await rp.evaluate(off,'window.__readyGates[0]');
  assert.equal(gate.deliveredAt,null,'结束前真实就绪通知仍被延迟');
  await rp.screenshot(panel,join(out,'1-spoken-while-connecting.png'));
  await rp.click(panel,'.voice-end');
  const stoppedAt=Date.now();
  await until(async()=>await rp!.evaluate(panel,'document.querySelector(".voice-progress")?.dataset.state==="idle"'),3000,'voice stopped');
  await until(async()=>await rp!.evaluate(off,'window.__readyGates[0]?.deliveredAt'),6000,'late real ready delivered');
  await sleep(1000);
  const state=await rp.evaluate(panel,'({phase:document.querySelector(".voice-progress")?.dataset.state,answer:document.querySelector(".voice-answer")?.textContent??""})');
  const appends=await rp.evaluate(off,'window.__appends');
  evidence={micAt,endMs,stoppedAt,gates:await rp.evaluate(off,'window.__readyGates'),state,appends,requestsBefore,requestsAfter:model.requests.length};
  assert.equal(state.phase,'idle');
  assert.equal(state.answer,'');
  assert.equal(appends,0,'结束后的旧首句没有发送到语音服务');
  assert.equal(model.requests.length,requestsBefore,'没有派发旧话的任务或分类');
  await rp.screenshot(panel,join(out,'2-stopped-no-replay.png'));
}catch(caught){error=caught instanceof Error?caught.stack??caught.message:String(caught);}
finally{await writeFile(join(out,'summary.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2));await rp?.close();await rp?.remove();await model.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error:error?.split('\n')[0]??null}));
if(error)process.exitCode=1;
