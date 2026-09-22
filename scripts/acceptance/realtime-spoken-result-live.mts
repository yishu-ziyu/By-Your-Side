// V2.3: isolated real providers, text input and browser receipt fixtures only.
// Run each scenario ONCE, only after the independent review of the tested source has passed.
import {mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {RealtimeVoiceConnection, MODEL} from '../../agent/src/realtime-voice-connection.js';
import {RouteShadow} from '../../agent/src/route-shadow.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';
import {classifyDirectExecutionFeedback} from '../../shared/execution-feedback.js';

export const SCENARIOS = [
  {id:'S1',text:'切到测试标签页。'},
  {id:'S2',text:'切到测试标签页，顺便告诉我一加一等于几。'},
  {id:'S3',text:'切到测试标签页，看看页面还需要什么。'},
] as const;
type Scenario = typeof SCENARIOS[number];
type Event = Record<string, any> & {at:number;type:string};
export type Trace = {provider:Event[];outgoing:Event[];client:Event[];logs:Event[];tools:Event[];judgments:Event[]};
export const newTrace = ():Trace => ({provider:[],outgoing:[],client:[],logs:[],tools:[],judgments:[]});
const hash = (value:Buffer|string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
const responseId = (e:Event):string|undefined => e.response_id ?? e.response?.id ?? e.responseId;
const ofType = (events:Event[],type:string) => events.filter(e=>e.type===type);
export function fixtureReceipt(id:string,name:string,args:Record<string,unknown>):Record<string,unknown> {
  if(name==='tabs'&&args.action==='list') return {tabs:[{id:7,title:'当前页',url:'https://fixture.test/'},{id:8,title:'测试标签页',url:'https://fixture.test/doc'}]};
  if(name==='tabs'&&args.action==='switch') return {tabId:Number(args.tabId??8)}; // fixture echo, NOT real switch verification
  if(name==='tabs'&&args.action==='active') return {tabId:8,url:'https://fixture.test/doc'};
  if(name==='snapshot') return {tabId:8,text:id==='S3'?'请登录后继续操作。登录后可继续查看与编辑文档。':'测试页面内容。'};
  throw new Error(`fixture does not execute ${name}:${String(args.action??'')}`);
}

/** Pair every response and tool output; count only new activity, never cumulative polling activity. */
export function isSettled(t:Trace):boolean {
  const created=ofType(t.provider,'response.created'), done=ofType(t.provider,'response.done');
  return created.length>0 && ofType(t.outgoing,'response.create').length===created.length
    && created.every(e=>done.some(d=>responseId(d)===responseId(e)) && t.client.some(c=>c.type==='response_done'&&responseId(c)===responseId(e)))
    && t.tools.every(call=>t.outgoing.filter(e=>e.item?.type==='function_call_output'&&e.item.call_id===call.callId).length===1)
    && t.judgments.length>0 && t.judgments.every(e=>e.completedAt!==null);
}
export function summarize(id:string,t:Trace,endedReason:string) {
  const gates=ofType(t.logs,'spoken_result_gate');
  const switchCall=t.tools.find(e=>e.name==='tabs'&&e.args?.action==='switch');
  const switchGate=gates.find(e=>e.callIds?.includes(switchCall?.callId));
  const finals=t.client.filter(e=>e.type==='transcript'&&e.role==='assistant'&&e.final);
  const ids=[...new Set(t.provider.filter(e=>e.type==='response.audio.delta').map(responseId))];
  const audio=ids.map(rid=>{
    const provider=Buffer.concat(t.provider.filter(e=>e.type==='response.audio.delta'&&responseId(e)===rid).map(e=>Buffer.from(e.delta,'base64')));
    const delivered=Buffer.concat(t.client.filter(e=>e.type==='audio'&&responseId(e)===rid).map(e=>Buffer.from(e.data,'base64')));
    return {responseId:rid,providerBytes:provider.length,deliveredBytes:delivered.length,providerHash:hash(provider),deliveredHash:hash(delivered)};
  });
  const delivered=(rid:string)=>audio.some(a=>a.responseId===rid&&a.providerBytes>0&&a.providerHash===a.deliveredHash);
  const continuationAfterSwitch=!!switchGate && t.outgoing.some(e=>e.type==='response.create'&&e.at>=switchGate.at);
  const request=t.judgments[0];
  const timely=typeof request?.completedAt==='number'&&!!switchGate&&request.completedAt<=switchGate.at;
  let reason:string|null=null;
  if(endedReason!=='quiescent'||!isSettled(t)) reason=endedReason==='quiescent'?'unsettled':endedReason;
  else if(!t.tools.some(e=>e.name==='tabs'&&e.args?.action==='list')||!switchCall) reason='list_or_switch_missing';
  else if(!t.outgoing.some(e=>e.item?.type==='function_call_output'&&e.item.call_id===switchCall.callId&&JSON.parse(e.item.output).hostFeedback?.text==='切好了')) reason='success_capsule_missing';
  else if(audio.some(a=>a.providerHash!==a.deliveredHash)) reason='audio_delivery_mismatch';
  else if(id==='S1') {
    if(switchGate?.applied===true) {
      if(continuationAfterSwitch||ofType(t.provider,'response.created').length!==2||audio.length!==0) reason='success_confirmation_generated';
    } else if(!continuationAfterSwitch||!finals.some(f=>delivered(f.responseId))) reason='fail_open_voice_missing';
  } else if(id==='S2') {
    if(!continuationAfterSwitch||!finals.some(f=>/一加一.*(二|2|两)/.test(f.text)&&delivered(f.responseId))) reason='spoken_answer_missing';
  } else if(id==='S3') {
    if(!t.tools.some(e=>e.name==='snapshot')||!finals.some(f=>/登录/.test(f.text)&&delivered(f.responseId))) reason='spoken_obstacle_missing';
  } else reason='unknown_scenario';
  return {id,status:reason?'FAIL':'PASS',reason,endedReason,request:request??null,timely,
    applied:switchGate?.applied===true,continuationReason:switchGate?.reason??null,
    failOpenReason:switchGate?.reason==='judgment_unavailable'?(timely?'judgment_invalid_or_unavailable':'judgment_late_or_unavailable'):null,
    reduction:id==='S1'?(switchGate?.applied===true?'applied':'not_applied'): 'not_expected',
    responseCount:ofType(t.provider,'response.created').length,
    toolResponseCount:new Set(t.provider.filter(e=>e.type==='response.function_call_arguments.done'||(e.type==='response.done'&&e.response?.output?.some((x:any)=>x.type==='function_call'))).map(responseId)).size,
    toolOutputCount:t.outgoing.filter(e=>e.item?.type==='function_call_output').length,
    continuationAfterSwitch,finals:finals.map(e=>({responseId:e.responseId,text:e.text})),audio};
}

const SOURCES=['agent/src/route-shadow.ts','agent/src/realtime-voice-connection.ts','agent/src/realtime-voice-session.ts','agent/src/voice-service.ts','agent/src/config.ts','shared/execution-feedback.ts','scripts/acceptance/realtime-spoken-result-live.mts'];
async function sourceHashes(){return Object.fromEntries(await Promise.all(SOURCES.map(async p=>[p,hash(await readFile(p))])));}

export async function main():Promise<number> {
  if(!process.argv.includes('--headless')) throw new Error('Requires --headless; no browser, microphone or speaker is opened.');
  const root=join('out/acceptance',`realtime-spoken-result-live-${Date.now()}`);await mkdir(root,{recursive:true});
  const before=await sourceHashes(), startedAt=Date.now();
  const results:any[]=[], traces:Record<string,Trace>={};
  let requests=0,responses=0,stopReason:string|null=null;
  const requestShapes:string[][]=[];
  const summaryPath=join(root,'result.json');
  let stepKey:string;
  try {stepKey=await readStepVoiceKey();if(!readTypeSafeKey())throw new Error('missing_jev_credential');}
  catch {await writeFile(summaryPath,JSON.stringify({status:'BLOCKED',reason:'missing_credentials',scenarios:SCENARIOS.map(s=>({id:s.id,status:'NOT_RUN'}))},null,2));console.log(summaryPath);return 1;}
  const shadowRoot=join(root,'request-audit');
  const shadow=new RouteShadow({enabled:()=>false,dailyLimit:()=>3,root:shadowRoot,fetch:async(...args)=>{
    if(requests>=3){stopReason='jev_cap';throw new Error(stopReason);}requests++;requestShapes.push(Object.keys(JSON.parse(String(args[1]?.body)).questions).sort());return fetch(...args);
  }});
  for(const scenario of SCENARIOS){
    if(stopReason){results.push({id:scenario.id,status:'NOT_RUN',reason:stopReason});continue;}
    const t=newTrace();traces[scenario.id]=t;
    let connection:RealtimeVoiceConnection,closed=false,ready=false,endedReason='timeout';
    const clientBytes=new Map<string,number>();
    const playbackTimers=new Set<ReturnType<typeof setTimeout>>();
    const record=(list:Event[],e:Record<string,any>)=>{if(!closed)list.push({...e,at:Date.now()} as Event);};
    connection=new RealtimeVoiceConnection({key:stepKey,voiceId:scenario.id,voiceSpokenResultGate:true,
      connect:key=>{
        const ws=new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}`,{headers:{Authorization:`Bearer ${key}`}});
        ws.on('message',raw=>{try {const e=JSON.parse(raw.toString());record(t.provider,e);if(e.type==='response.created'&&++responses>=15){stopReason='response_cap';connection.close();}}catch{}});
        const send=ws.send.bind(ws);ws.send=((data:any)=>{try{record(t.outgoing,JSON.parse(String(data)));}catch{}return send(data);}) as typeof ws.send;
        return ws;
      },
      judgeRequest:async input=>{
        const request:Event={type:'judgment',at:Date.now(),...input,completedAt:null,judgment:null};t.judgments.push(request);
        try {return request.judgment=await shadow.judge({channel:'voice',conversationId:'isolated',...input,previous:[],taskRunning:false},true);}
        finally {request.completedAt=Date.now();}
      },
      log:e=>record(t.logs,e),
      send:e=>{
        record(t.client,e);if(e.type==='ready')ready=true;
        if(e.type==='audio')clientBytes.set(String(e.responseId),(clientBytes.get(String(e.responseId))??0)+Buffer.from(String(e.data),'base64').length);
        if(e.type==='response_done'){
          const timer=setTimeout(()=>{playbackTimers.delete(timer);if(!closed)connection.handle({type:'playback_done',responseId:e.responseId});},Math.max(1,(clientBytes.get(String(e.responseId))??0)/48));
          playbackTimers.add(timer);
        }
      },
      tools:{browserTool:async call=>{
        record(t.tools,{type:'tool',name:call.name,args:call.args,callId:call.callId,inputId:call.inputId});
        const data=fixtureReceipt(scenario.id,call.name,call.args??{});
        const feedback=classifyDirectExecutionFeedback({tool:call.name,args:call.args,executionFact:'executed',data,toolCallId:call.callId,inputId:call.inputId});
        return {ok:true,executionFact:'executed',...data,...(feedback?{feedback}:{})};
      },browser_request:async()=>({ok:false,error:'隔离夹具未接委派任务'}),read_page:async()=>({ok:false,error:'请用 snapshot 读取夹具页面'}),task_status:async()=>({ok:true,tasks:[]})},
    });
    try {
      connection.start();const readyDeadline=Date.now()+20_000;
      while(!ready&&Date.now()<readyDeadline&&!t.client.some(e=>e.type==='closed')&&!stopReason)await sleep(100);
      if(!ready)endedReason='not_ready';
      else {
        connection.handle({type:'text',text:scenario.text});const deadline=Date.now()+100_000;
        let size=0,lastActivity=Date.now();
        while(Date.now()<deadline){
          if(Date.now()-startedAt>=360_000)stopReason='total_cap';
          if(stopReason){endedReason=stopReason;break;}
          if(t.client.some(e=>e.type==='closed'||e.type==='error')){endedReason='connection_closed';break;}
          const nextSize=t.provider.length+t.outgoing.length+t.client.length+t.logs.length;
          if(nextSize!==size){size=nextSize;lastActivity=Date.now();}
          if(isSettled(t)&&Date.now()-lastActivity>=2000){endedReason='quiescent';break;}
          await sleep(100);
        }
      }
    } finally {closed=true;for(const timer of playbackTimers)clearTimeout(timer);connection.close();}
    const result=summarize(scenario.id,t,endedReason);results.push(result);
    for(const item of result.audio){
      for(const [label,events,type,field] of [['provider',t.provider,'response.audio.delta','delta'],['delivered',t.client,'audio','data']] as const){
        const pcm=Buffer.concat(events.filter(e=>e.type===type&&responseId(e)===item.responseId).map(e=>Buffer.from(e[field],'base64')));
        await writeFile(join(root,`${scenario.id}-${hash(String(item.responseId)).slice(0,12)}-${label}.pcm`),pcm);
      }
    }
    console.log(scenario.id,result.status,result.failOpenReason??'');
  }
  const after=await sourceHashes();
  const audit=await readdir(shadowRoot).catch(()=>[]);
  const requestAudit=(await Promise.all(audit.map(async f=>(await readFile(join(shadowRoot,f),'utf8')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l))))).flat();
  const sourceChanged=JSON.stringify(before)!==JSON.stringify(after);
  await writeFile(summaryPath,JSON.stringify({startedAt,endedAt:Date.now(),input:'text',browser:'receipt_fixture',audio:'PCM delivery; no speaker',
    independentReview:'required_before_running',requests,requestShapes,responses,stopReason,sourceChanged,before,after,results,requestAudit,traces},null,2));
  console.log(summaryPath);
  return sourceChanged||stopReason||results.some(r=>r.status!=='PASS')?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
