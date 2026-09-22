/** Offline collection rules only. Language/evidence agreement requires a separate human reading. */
export interface FactEvent { seq: number; at: number; channel: string; data: Record<string, any> }
export type FactScenario = 'A' | 'B' | 'C' | 'D';
export const isPageRead = (name:string) => ['snapshot','observe_page','read_element','read_elements'].includes(name);
export interface FactProbe { value: string; writes: string[]; saved: number; submitted: number; deleted: number; code: string }

export function providerCalls(events: FactEvent[]) {
  const calls = new Map<string, {callId:string;responseId:string;name:string;arguments:unknown;at:number;seq:number}>();
  for (const e of events.filter(e=>e.channel==='provider-in')) {
    const items = e.data.type==='response.function_call_arguments.done' ? [e.data] : e.data.type==='response.done' ? e.data.response?.output ?? [] : [];
    for (const item of items) if (item.call_id && item.name && !calls.has(item.call_id)) calls.set(item.call_id, {
      callId:item.call_id,responseId:e.data.response_id ?? e.data.response?.id,name:item.name,arguments:item.arguments,at:e.at,seq:e.seq,
    });
  }
  return [...calls.values()];
}
export function toolOutputs(events: FactEvent[]) {
  return events.filter(e=>e.channel==='provider-out'&&e.data.item?.type==='function_call_output').map(e=>{
    let result: any;
    try { result=JSON.parse(e.data.item.output); } catch { result={unparseable:true,raw:e.data.item.output}; }
    return {seq:e.seq,at:e.at,callId:e.data.item.call_id,result};
  });
}
/** A tool-bearing response or pre-tool preamble is never the final result reply. */
export function finalReply(events: FactEvent[]) {
  const incoming=events.filter(e=>e.channel==='provider-in');
  const created=incoming.filter(e=>e.data.type==='response.created').at(-1);
  if(!created)return null;
  const id=created.data.response?.id;
  const done=incoming.find(e=>e.seq>created.seq&&e.data.type==='response.done'&&e.data.response?.id===id);
  if(!done||done.data.response?.status!=='completed')return null;
  const calls=providerCalls(events),outputs=toolOutputs(events);
  if(calls.some(c=>c.responseId===id||!outputs.some(o=>o.callId===c.callId&&o.seq<created.seq)))return null;
  let text='';
  for(const e of incoming.filter(e=>e.data.response_id===id)) {
    if(['response.audio_transcript.delta','response.text.delta'].includes(e.data.type))text+=e.data.delta??'';
    if(['response.audio_transcript.done','response.text.done'].includes(e.data.type))text=e.data.transcript??e.data.text??text;
  }
  const full=(done.data.response?.output??[]).filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content??[]).map((c:any)=>c.transcript??c.text??'').join('');
  if(full)text=full;
  const audio=incoming.find(e=>e.seq>=created.seq&&e.data.type==='response.audio.delta'&&e.data.response_id===id);
  return {responseId:id,text:text.trim(),complete:!!text.trim(),createdSeq:created.seq,doneSeq:done.seq,doneAt:done.at,firstAudioAt:audio?.at??null};
}

type EvidenceStatus = 'PASS' | 'FAIL' | 'UNDETERMINED';
const unique = <T,>(items:T[]):T|undefined => items.length===1?items[0]:undefined;
const completeId = (value:unknown):value is string => typeof value==='string' && value.length>0 && !/redacted|truncated|\.\.\.|…/i.test(value);
const succeeded = (result:any) => result?.ok===true && result.executionFact==='executed' && !result.truncated;

/** Only the existing read_element JSON envelope, not arbitrary page prose. */
function fieldOutput(result:any) {
  if(!succeeded(result)||result.content?.length!==1)return null;
  const text=result.content[0]?.text;
  if(typeof text!=='string')return null;
  const match=/^<page-content untrusted tab=(\d+)>\n([\s\S]*)\n<\/page-content>$/.exec(text);
  if(!match)return null;
  try {
    const field=JSON.parse(match[2]!);
    return field && field.tabId===Number(match[1]) && typeof field.value==='string' && !field.truncated ? field : null;
  } catch {return null;}
}

/** No inferred host/transport join: absent explicit shared identity stays unknown. */
function assessReadback(events:FactEvent[],expected:string) {
  const dispatches=events.filter(e=>e.channel==='extension-out'&&e.data.type==='tool_call');
  const writes=dispatches.filter(e=>['fill','type_text'].includes(e.data.name));
  const reads=dispatches.filter(e=>isPageRead(e.data.name));
  const write=unique(writes);
  const calls=providerCalls(events),outputs=toolOutputs(events);
  const created=events.filter(e=>e.channel==='provider-in'&&e.data.type==='response.created').at(-1);
  const responseId=created?.data.response?.id;
  const done=unique(events.filter(e=>e.channel==='provider-in'&&e.data.type==='response.done'&&e.data.response?.id===responseId));
  const finalBoundary=created&&done&&done.seq>created.seq&&done.data.response.status==='completed'&&
    !(done.data.response.output??[]).some((item:any)=>item.type==='function_call')&&!calls.some(c=>c.responseId===responseId)?created:null;
  const generationRequests=events.filter(e=>e.channel==='provider-out'&&e.data.type==='response.create'&&e.seq<(created?.seq??0));
  const generationRequest=generationRequests.at(-1);
  const generationBoundary=generationRequest&&(!calls.length||generationRequest.seq>Math.max(...calls.map(c=>c.seq)))?generationRequest:finalBoundary;
  const receipt=(dispatch:FactEvent)=>unique(events.filter(e=>e.channel==='extension-in'&&e.data.type==='tool_result'&&e.data.id===dispatch.data.id));
  const writeResult=write&&receipt(write);
  const target=write?.data.params;
  const evidence=reads.filter(read=>!write||read.seq>write.seq||(receipt(read)?.seq??0)>write.seq).map(read=>{
    const result=receipt(read),params=read.data.params,field=result?.data.data;
    let observation:EvidenceStatus='UNDETERMINED',reason='missing write, dispatch identity, or receipt';
    if(write&&completeId(write.data.id)&&writeResult&&succeeded(writeResult.data)&&writeResult.seq>write.seq&&result&&completeId(read.data.id)&&
      dispatches.filter(e=>e.data.id===read.data.id).length===1) {
      if(read.seq<=writeResult.seq) {observation='FAIL';reason='read dispatched before write completed';}
      else if(!succeeded(result.data)||result.seq<=read.seq) {observation='FAIL';reason='read failed or receipt precedes dispatch';}
      else if(target?.tabId!=null&&params?.tabId!=null&&target.tabId!==params.tabId ||
        completeId(target?.target)&&completeId(params?.target)&&target.target!==params.target) {
        observation='FAIL';reason='read dispatched to another tab or field';
      } else if(!Number.isInteger(target?.tabId)||!completeId(target?.target)||!completeId(target?.documentId)||
        !Number.isInteger(params?.tabId)||!completeId(params?.target)||params?.truncated||
        !Number.isInteger(field?.tabId)||!completeId(field?.target)||!completeId(field?.documentId)||field?.truncated) {
        reason='missing resolved page/document/field identity';
      } else if(read.data.name!=='read_element'||typeof field?.value!=='string') {
        reason='no supported structured field value';
      } else if(field.tabId!==target.tabId||field.target!==target.target||field.documentId!==target.documentId ||
        params.documentId!=null&&params.documentId!==target.documentId) {
        observation='FAIL';reason='returned field does not match write target';
      } else {observation='PASS';reason='same field read after completed write';}
    }
    const end=unique(events.filter(e=>e.channel==='direct-end'&&e.data.result?.toolCallId===read.data.id));
    const call=end&&unique(calls.filter(c=>c.callId===end.data.callId));
    const start=call&&unique(events.filter(e=>e.channel==='direct-start'&&e.data.callId===call.callId));
    const matchingOutputs=call?outputs.filter(o=>o.callId===call.callId):[];
    const sent=unique(matchingOutputs);
    if(observation==='PASS'&&start&&writeResult&&start.seq<=writeResult.seq) {
      observation='FAIL';reason='host read started before write completed';
    }
    let delivered:EvidenceStatus='UNDETERMINED';
    let deliveryReason='missing explicit transport/host/provider identity or final response';
    if(end&&call&&completeId(call.responseId)&&start&&result&&finalBoundary&&completeId(responseId)) {
      if(!(call.seq<=start.seq&&start.seq<read.seq&&result.seq<end.seq)||call.name!==read.data.name||end.data.name!==call.name) {
        delivered='FAIL';deliveryReason='inconsistent call chain';
      } else if(matchingOutputs.length>1) {
        deliveryReason='multiple outputs for one provider call';
      } else if(!sent||sent.seq>=(generationBoundary?.seq??finalBoundary.seq)||sent.seq<=end.seq) {
        delivered='FAIL';deliveryReason='no output sent before final response creation';
      } else {
        const hostField=fieldOutput(end.data.result),sentField=fieldOutput(sent.result);
        if(sent.result.toolCallId!==read.data.id||!hostField||!sentField) {
          deliveryReason='missing or failed structured host/provider output';
        } else if(!completeId(field?.documentId)||!completeId(hostField.documentId)||!completeId(sentField.documentId)) {
          deliveryReason='truncated or missing output document identity';
        } else if(['tabId','target','documentId','value'].every(key=>field[key]===hostField[key]&&field[key]===sentField[key])) {
          delivered='PASS';deliveryReason='correlated field output sent before final response creation';
        } else {delivered='FAIL';deliveryReason='output differs from this read receipt';}
      }
    }
    return {transportId:read.data.id,toolCallId:end?.data.result?.toolCallId??null,callId:call?.callId??null,
      responseId:call?.responseId??null,finalResponseId:responseId??null,dispatchSeq:read.seq,resultSeq:result?.seq??null,
      sentSeq:sent?.seq??null,finalCreatedSeq:finalBoundary?.seq??null,generationBoundarySeq:generationBoundary?.seq??null,observation,reason,delivered,deliveryReason,
      value:observation==='PASS'?field.value:null,valueMatches:observation==='PASS'?(field.value===expected?'PASS':'FAIL') as EvidenceStatus:'UNDETERMINED' as EvidenceStatus};
  });
  // Preserve each observation; conflicting/multiple valid reads need review rather than cherry-picking a success.
  const valid=evidence.filter(e=>e.observation==='PASS');
  const selected=unique(valid);
  const postActionRead:EvidenceStatus=selected?'PASS':valid.length?'UNDETERMINED':evidence.some(e=>e.observation==='UNDETERMINED')?'UNDETERMINED':'FAIL';
  return {postActionRead,readEvidenceDelivered:selected?.delivered??(evidence.length?'UNDETERMINED':'FAIL'),
    readValueMatches:selected?.valueMatches??'UNDETERMINED',readbackEvidence:evidence};
}

export function assessFactRun(scenario:FactScenario, events:FactEvent[], probe:FactProbe|null, expected='星河') {
  const calls=providerCalls(events),outputs=toolOutputs(events),reply=finalReply(events);
  const user=events.filter(e=>e.channel==='provider-in'&&e.data.type==='conversation.item.input_audio_transcription.completed');
  const stopped=events.filter(e=>e.channel==='provider-in'&&e.data.type==='input_audio_buffer.speech_stopped').at(-1);
  const firstTool=events.find(e=>e.channel==='extension-out');
  const writes=calls.filter(c=>['fill','type_text','press_key','click'].includes(c.name));
  const firstAction=events.find(e=>e.channel==='extension-out'&&['fill','click','type_text','press_key','scroll','navigate','switch_tab'].includes(e.data.name));
  const injections=events.filter(e=>e.channel==='injection');
  const held=outputs.some(o=>o.result.executionFact==='not_executed'&&JSON.stringify(o.result.content??'').includes('Held click'));
  const dropped=injections.some(e=>e.data.kind==='drop-write-result');
  const unknown=outputs.find(o=>o.result.executionFact==='unknown');
  const readFailed=outputs.some(o=>o.result.ok===false&&String(o.result.error).includes('TEST_INJECTED_READ_FAILURE'));
  const coverage=!!calls.length&&(scenario==='A'?writes.some(c=>c.name==='fill'):scenario==='B'?held:scenario==='C'?dropped&&!!unknown:readFailed);
  const sideEffects=probe ? probe.saved+probe.submitted+probe.deleted : null;
  const repeated=!!probe&&(scenario==='A'||scenario==='C')&&(probe.writes.length>1||!!unknown&&writes.some(c=>c.seq>unknown.seq));
  const action=!probe?'UNDETERMINED':!coverage?'FAIL':sideEffects!==0?'FAIL':
    scenario==='A'||scenario==='C'?(probe.value===expected&&probe.writes.length===1?'PASS':'FAIL'):'PASS';
  const readback=assessReadback(events,expected);
  return {
    scenarioCoverage:coverage?'PASS':'FAIL', action, ...(['A','C'].includes(scenario)?readback:
      {postActionRead:'NOT_APPLICABLE',readEvidenceDelivered:'NOT_APPLICABLE',readValueMatches:'NOT_APPLICABLE',readbackEvidence:[]}),
    language:'NOT_JUDGED', finalAnswer:reply?.complete?'CAPTURED':'UNDETERMINED', prohibition:probe?sideEffects===0?'PASS':'FAIL':'UNDETERMINED',
    repeatedExecution:probe?repeated?'FAIL':'PASS':'UNDETERMINED', finalReply:reply,
    userTranscripts:user.map(e=>({itemId:e.data.item_id,text:e.data.transcript})),
    timing:{boundary:'last provider input_audio_buffer.speech_stopped receipt (all synthetic utterance segments); action = host→extension dispatch; audio = final response first server audio delta, not audible playback',speechStoppedAt:stopped?.at??null,
      firstToolMs:stopped&&firstTool?firstTool.at-stopped.at:null,firstActionMs:stopped&&firstAction?firstAction.at-stopped.at:null,resultAudioMs:stopped&&reply?.firstAudioAt?reply.firstAudioAt-stopped.at:null},
    counts:{providerToolCalls:calls.length,hostDirectCalls:events.filter(e=>e.channel==='direct-start').length,browserDispatches:events.filter(e=>e.channel==='extension-out').length,
      realtimeResponses:new Set(events.filter(e=>e.channel==='provider-in'&&e.data.type==='response.created').map(e=>e.data.response?.id)).size,
      otherModelRequests:events.filter(e=>e.channel==='model-http-start').length},
    calls,outputs,
  };
}
