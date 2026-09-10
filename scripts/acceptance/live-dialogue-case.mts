/** Scenario for the existing isolated production sidepanel harness. No user browser. */
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ConversationManager} from '../../agent/src/conversation-manager.js';

export async function runLiveDialogue(h:{out:string;report:any;messages:any[];manager:ConversationManager;panelEval:(s:string)=>Promise<any>;listen:()=>Promise<void>;until:<T>(fn:()=>T|undefined|Promise<T|undefined>,ms?:number)=>Promise<T>;check:(name:string,ok:boolean)=>void;release:()=>void;isHeld:()=>boolean;targetCode:string;otherCode:string}){
  const {report,messages,manager,until,check}=h;
  const runtime=(manager.get('default')!.runtime.session as any).modelRuntime;
  const originalComplete=runtime.completeSimple.bind(runtime);
  runtime.completeSimple=async(...args:any[])=>{const r=await originalComplete(...args);if(String(args[1]?.systemPrompt).startsWith('你只分类'))(report.classifierReplies??=[]).push({at:Date.now(),input:args[1]?.messages?.[0]?.content,reply:r.content?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('')});return r;};
  await h.listen();
  let index=0;
  const utter=async(text:string)=>{
    report.stage='live dialogue: '+text;console.log(report.stage);
    const base=join(h.out,'dialogue-input-'+(++index));
    execFileSync('/usr/bin/say',['-v','Tingting','-r','200','-o',base+'.aiff',text]);
    execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
    const pcm=Buffer.concat([await readFile(base+'.pcm'),Buffer.alloc(48000)]),from=messages.length,at=Date.now();
    await h.panelEval(`injectSpeech(${JSON.stringify(pcm.toString('base64'))})`);
    const end=await until(()=>{if(report.transportError)throw Error(report.transportError);if(report.stages.some((e:any)=>e.event==='turn_failed'&&e.at>=at))throw Error('Voice turn failed');const error=messages.slice(from).find(m=>m.type==='voice'&&m.event.kind==='state'&&m.event.state==='error');if(error)throw Error(error.event.detail);return messages.slice(from).find(m=>m.type==='voice'&&m.event.kind==='response_end');},60000);
    await until(()=>report.clientTiming?.find((e:any)=>e.command==='playback_done'&&e.responseId===end.event.responseId),30000);
    // Early speech is deliberately independent of routing; observe the actual receipt separately.
    await until(()=>report.stages.find((e:any)=>e.event==='route_result'&&e.turn===end.event.turn&&e.at>=at),20000);
    await until(()=>messages.slice(from).filter(m=>m.type==='voice'&&m.event.kind==='state').at(-1)?.event.state==='ready'||undefined,30000);
    const answers=messages.slice(from).filter(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text);
    const commit=report.clientTiming?.findLast((e:any)=>e.command==='commit'&&e.at>=at);
    const first=report.audioTiming?.find((e:any)=>e.firstAudioAt>=at);
    (report.dialogue??=[]).push({question:text,answers,runId:manager.getTaskProgress('default')?.runId,state:manager.getTaskProgress('default')?.state,commitAt:commit?.at,firstAudioAt:first?.firstAudioAt,commitToAudioMs:first&&commit?first.firstAudioAt-commit.at:null});
    check('turn '+index+' has actual audio before task completion',!!first&&manager.getTaskProgress('default')?.state==='running');
    return answers.join('\n');
  };
  const start=messages.length;
  const ack=await utter('帮我等测试资料准备好，再读一下当前页面，告诉我两种模型的有效期。');
  check('first response acknowledges this request without claiming a result',/看|查|读|资料|模型|等/.test(ack)&&!ack.includes(h.targetCode)&&!ack.includes(h.otherCode));
  await until(()=>h.isHeld()||undefined,30000);
  const runId=manager.getTaskProgress('default')?.runId;
  const chat1=await utter('等的时候聊两句，我今天脑子有点乱。');
  const chat2=await utter('就是事情太多了，一时不知道从哪件开始。');
  check('two conversational responses contain no false completion',!!chat1&&!!chat2&&!/任务已完成|已暂停|已终止|盯着页面|正在看页面|已经看到/.test(chat1+chat2));
  const receipts=()=>messages.slice(start).filter(m=>m.type==='agent_event'&&m.event.kind==='notice'&&m.event.receipt).map(m=>m.event.receipt);
  check('chat did not dispatch a task change',!receipts().some(r=>r.action==='steer'||r.action==='pause'||r.action==='abort'));
  await utter('改一下，只告诉我标准模型的有效期，临时模型先不看。');
  check('correction stays on the original running task',manager.getTaskProgress('default')?.runId===runId);
  check('correction is accepted exactly once',new Set(receipts().filter(r=>r.action==='steer'&&r.status==='accepted').map(r=>r.requestId)).size===1);
  check('only one task was started',messages.slice(start).filter(m=>m.type==='agent_event'&&m.event.kind==='agent_start').length===1);
  const from=messages.length;h.release();report.stage='live dialogue: corrected result';
  await until(()=>manager.getTaskProgress('default')?.state==='idle'||undefined,120000);
  const result=await until(()=>messages.slice(from).find(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind==='finding'),60000);
  const speech=await until(()=>report.stages.find((e:any)=>e.event==='tts_first_audio'&&e.deliveryId===result.event.delivery.id),60000);
  check('real corrected browser result is spoken',!!speech&&/长期/.test(result.event.delivery.text)&&!/明天/.test(result.event.delivery.text));
  const completed=await until(()=>messages.slice(from).find(m=>m.type==='voice'&&m.event.kind==='response_end'),60000);
  await until(()=>report.clientTiming?.find((e:any)=>e.command==='playback_done'&&e.responseId===completed.event.responseId),60000);
  check('no page pause was dispatched for ordinary speech',!messages.slice(start).some(m=>m.type==='task_control'));
  report.liveResult={delivery:result.event.delivery,runId,completedAt:Date.now()};
}
