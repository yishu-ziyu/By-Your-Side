/** 前提：只延迟真实就绪帧，能让整句在连接阶段说完；不是产品验收。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, until } from '../acceptance/real-path/harness.mts';
import { startScriptedModel } from '../acceptance/real-path/scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/session-recovery',`${new Date().toISOString().replace(/[:.]/g,'-')}-first-utterance-premise`);
await mkdir(out,{recursive:true});
const wav=join(out,'microphone.wav');
execFileSync('say',['-v','Tingting','-o',wav,'--data-format=LEI16@24000','[[slnc 300]]这个页面上的备注写的是什么[[slnc 1000]]']);
const raw=await readFile(wav), endMs=(raw.length-raw.indexOf('data')-8)/48-1000;
const key=(await readFile(join(homedir(),'.sideagent/stepfun-api.key'),'utf8')).trim();
const model=await startScriptedModel([]), rp=await launchRealPath({microphoneWav:wav});
let error:string|null=null, evidence:unknown=null;
try {
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'},inproc_voice_key:key})})`);
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.getAttribute("aria-busy")!=="true"'),30000,'assistant ready');
  const off=await rp.attach((await until(async()=>(await rp.targets()).find(t=>t.url.endsWith('/inproc.html')),10000,'offscreen')).targetId);
  await rp.evaluate(off,`(()=>{window.__readyGates=[];const add=WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener=function(type,listener,...rest){if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      return add.call(this,type,function(event){if(JSON.parse(event.data).type==='session.updated'){
        const gate={receivedAt:Date.now(),deliveredAt:null};window.__readyGates.push(gate);
        setTimeout(()=>{gate.deliveredAt=Date.now();listener.call(this,event);},4000);return;
      }return listener.call(this,event);},...rest);};return true;})()`);
  await rp.evaluate(panel,`(()=>{const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{const stream=await get(...args);window.__micAt=Date.now();return stream;};return true;})()`);
  await rp.click(panel,'.voice-start');
  const gate=await until(async()=>(await rp.evaluate(off,'window.__readyGates')).find((g:{deliveredAt:number|null})=>g.deliveredAt),15000,'real ready delayed') as {receivedAt:number;deliveredAt:number};
  const micAt=await rp.evaluate(panel,'window.__micAt') as number;
  evidence={micAt,endMs,gate};
  assert.ok(micAt+endMs<gate.deliveredAt,'整句在真实就绪通知交付前说完');
  assert.ok(gate.deliveredAt-gate.receivedAt>=3900,'延迟的是实际服务商通知');
  await rp.screenshot(panel,join(out,'panel.png'));
}catch(caught){error=String(caught);}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',error,evidence},null,2));await rp.close();await rp.remove();await model.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));
if(error)process.exitCode=1;
