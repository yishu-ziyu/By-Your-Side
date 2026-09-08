/** Live idle-connection recovery only: production Step session + empty task progress. */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {StepVoiceSession} from '../../agent/src/voice-session.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {TaskProgress} from '../../agent/src/task-progress.js';
const out=`/tmp/ego-voice-idle-${Date.now()}`;await mkdir(out,{recursive:true});
const events:any[]=[];let ready=false,done=false,error:string|undefined;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const p=new TaskProgress('idle-check');
const voice=new StepVoiceSession({getSnapshot:()=>p.snapshot(),emit:e=>{
 events.push({at:Date.now(),...(e.kind==='audio'?{kind:'audio',bytes:Buffer.from(e.data,'base64').length}:e)});
 if(e.kind==='state'&&e.state==='ready')ready=true;
 if(e.kind==='state'&&e.state==='error')error=e.detail;
 if(e.kind==='response_end'){voice.command({kind:'playback_done',responseId:e.responseId});done=true;}
}});
let ok=false;
try{
 voice.start(await readStepVoiceKey());for(let i=0;i<150&&!ready;i++)await sleep(100);if(!ready)throw Error(error??'No ready state');
 execFileSync('/usr/bin/say',['-v','Tingting','-o',`${out}/input.aiff`,'你好，十加七等于多少？']);
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',`${out}/input.aiff`,'-ar','24000','-ac','1','-f','s16le',`${out}/input.pcm`]);
 const pcm=Buffer.concat([await readFile(`${out}/input.pcm`),Buffer.alloc(24000)]);
 for(const turn of [1,2]){
  done=false;voice.command({kind:'interrupt',turn});for(let i=0;i<pcm.length;i+=960){voice.command({kind:'audio',turn,data:pcm.subarray(i,i+960).toString('base64')});await sleep(20);}
  voice.command({kind:'commit',turn});for(let i=0;i<300&&!done&&!error;i++)await sleep(100);
  if(!done||error)throw Error(error??'Response timeout');
  if(turn===1){console.log('First response completed; checking 70 seconds idle before next turn');await sleep(70000);if(error)throw Error(error);}
 }
 ok=done&&!error&&events.some(e=>e.kind==='audio')&&events.some(e=>e.kind==='text'&&e.role==='user');
}catch(e){error=String(e);}finally{voice.close();await writeFile(`${out}/result.json`,JSON.stringify({ok,error,idleMs:70000,events},null,2));console.log(JSON.stringify({out,ok,error}));if(!ok)process.exitCode=1;}
