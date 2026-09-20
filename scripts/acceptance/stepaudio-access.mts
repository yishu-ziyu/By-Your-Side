/** Bounded access/configuration probe only: no microphone, playback, tools or product mutation. */
import WebSocket from 'ws';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';

if (!process.argv.includes('--live')) throw new Error('Real provider access requires --live');
const outIndex = process.argv.indexOf('--report');
const out = resolve(outIndex < 0 ? `out/acceptance/stepaudio-access-${Date.now()}` : process.argv[outIndex + 1]!);
await mkdir(out, {recursive:true});
const arms = [
  {id:'3-open', model:'stepaudio-3-realtime-preview', path:'/v1/realtime', key:process.env.STEPFUN_API_KEY?.trim()},
  {id:'2.5-plan', model:'stepaudio-2.5-realtime', path:'/step_plan/v1/realtime', key:await readStepVoiceKey().catch(() => undefined)},
];
const results: Record<string, unknown>[] = [];
for (const arm of arms) {
  const result: Record<string, unknown> = {id:arm.id, model:arm.model, path:arm.path, status:'BLOCKED', events:[]};
  const events = result.events as {type:string;elapsedMs:number}[];
  const start = Date.now();
  if (!arm.key) result.reason='missing credential';
  else await new Promise<void>((done) => {
    const socket = new WebSocket(`wss://api.stepfun.com${arm.path}?model=${arm.model}`, {
      headers:{Authorization:`Bearer ${arm.key}`}, handshakeTimeout:10_000, followRedirects:false,
    });
    let finished = false;
    const finish = (status:string, reason?:string) => {
      if (finished) return;
      finished=true; clearTimeout(timer); result.status=status;
      if (reason) result.reason=reason.split(arm.key!).join('[REDACTED]');
      socket.terminate(); done();
    };
    const timer = setTimeout(() => finish('BLOCKED','15s access/configuration timeout'),15_000);
    socket.on('error', error => finish('BLOCKED',error.message));
    socket.on('close', code => finish('BLOCKED',`closed before configuration: ${code}`));
    socket.on('unexpected-response', (_req,response) => {response.resume();finish('BLOCKED',`HTTP ${response.statusCode}`);});
    socket.on('message', raw => {
      try {
        const event=JSON.parse(raw.toString()); events.push({type:event.type,elapsedMs:Date.now()-start});
        if (event.type==='error') {finish('BLOCKED',String(event.error?.message ?? 'provider error'));return;}
        if (event.type==='session.created') {
          result.reportedModel=event.session?.model ?? null;
          socket.send(JSON.stringify({type:'session.update',session:{modalities:['text','audio'],
            voice:'wenrounansheng', input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:null,
            instructions:'这是连接检查，不执行任务。'}}));
        }
        if (event.type==='session.updated') {
          result.configuration={voice:event.session?.voice,inputFormat:event.session?.input_audio_format,
            outputFormat:event.session?.output_audio_format,turnDetection:event.session?.turn_detection};
          // Access is distinct from turn behavior: the live service echoes null as {type:""}.
          // Do not infer whether automatic/manual responses work from that serialization alone.
          result.manualTurnBehavior='NOT_RUN';
          const exact=result.reportedModel===arm.model && event.session?.input_audio_format==='pcm16'
            && event.session?.output_audio_format==='pcm16' && event.session?.voice==='wenrounansheng';
          finish(exact?'PASS':'BLOCKED',exact?undefined:'model or audio format/voice not confirmed');
        }
      } catch {finish('BLOCKED','invalid provider event');}
    });
  });
  result.elapsedMs=Date.now()-start; results.push(result);
  await writeFile(resolve(out,'result.json'),JSON.stringify({scope:'access-only',humanAudio:false,results},null,2)+'\n');
  console.log(JSON.stringify(result));
}
if (results.some(r=>r.status!=='PASS')) process.exitCode=1;
