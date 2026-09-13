/** Loaded extension/native-host transport smoke. Synthetic PCM, no microphone.
 * Player completion here is simulated; actual VoicePlayer is checked separately
 * by voice-greeting-live.mts. Only creates an owned test conversation/panel.
 */
import {randomUUID} from 'node:crypto';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const h=await NativeVoiceHarness.open('voice-greeting-native');
const report:any={scope:'Installed extension port + native host + real ASR/Pi/TTS; synthetic PCM; simulated playback_done, not human audio acceptance',ok:false};
try{
  const requestId=randomUUID();
  await h.send({type:'conversation_create',requestId,title:'自动验收 · 一次语音问候'});
  const created=await h.wait(`(globalThis.__saServerEvents||[]).find(e=>e.type==='conversation_created'&&e.requestId===${JSON.stringify(requestId)})`);
  const id=created.conversation.id;h.ids.push(id);
  await h.send({type:'set_model',conversationId:id,model:'opencode-go/deepseek-flash'});
  await h.wait(`${h.events(id)}.some(e=>e.type==='model_info'&&e.model==='opencode-go/deepseek-flash')`);
  await h.listen(id);await h.speak('嗨，晚上好。');
  await new Promise(r=>setTimeout(r,2500));
  const raw=await h.w(`${h.events(id)}.filter(e=>e.type==='voice'&&e.voiceId===${JSON.stringify(h.voiceId)})`);
  const updates=raw.filter((e:any)=>e.event.kind==='text'&&e.event.role==='assistant').map((e:any)=>e.event.text);
  const ends=raw.filter((e:any)=>e.event.kind==='response_end').map((e:any)=>e.event.responseId);
  const audio=raw.filter((e:any)=>e.event.kind==='audio');
  report.conversationId=id;report.voiceId=h.voiceId;report.textUpdates=updates;report.responses=ends;report.audioFrames=audio.length;
  report.recognized=raw.filter((e:any)=>e.event.kind==='text'&&e.event.role==='user').map((e:any)=>e.event.text);
  h.check('one native spoken reply',new Set(ends).size===1);
  h.check('native reply has audio',audio.length>0);
  h.check('one cumulative native answer',updates.length>0&&updates.every((v:string,i:number)=>i===0||v.startsWith(updates[i-1])));
  h.check('no generic task acknowledgement',!updates.some((v:string)=>v.includes('任务已收到')));
  report.browserCalls=await h.w(`${h.events(id)}.filter(e=>e.type==='tool_call').map(e=>e.name)`);
  h.check('greeting does not automatically inspect a page',!report.browserCalls.some((name:string)=>['snapshot','read_element'].includes(name)));
  report.answer=updates.at(-1);
  h.check('greeting does not become an unsolicited page report',report.answer.length<=55&&!/我.*看到|页面上|笔记|招聘|岗位|flomo/.test(report.answer));
  report.ok=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,...report}));}
