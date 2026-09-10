import { microphonePermissionState } from "./voice-permission.js";
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.js';
import { VoiceClient, type VoicePhase } from './voice-client.js';
import { mountOrb } from './voice-orb.js';
import { VoiceDiagnosticLog, type VoiceDiagCapture } from './voice-diagnostic.js';
import type { UserDelivery, VoiceInputContext } from '../../../shared/voice.js';

export function mountVoiceUI(composer: HTMLElement, getConversation:()=>string, send:(m:ClientMessage)=>boolean,getInput:()=>VoiceInputContext=()=>({}),diagnostic?:(event:string,fields:Record<string,string|number|boolean|null|undefined>)=>void) {
  const region=document.createElement('section');region.className='voice-progress';region.hidden=true;
  region.setAttribute('aria-label','语音问进度');
  region.innerHTML='<canvas class="voice-orb" aria-label="语音粒子球"></canvas><button class="voice-end" type="button">结束</button><div class="voice-state" role="status"></div><div class="voice-hint">随时插话 · 可调整当前任务</div><div class="voice-question voice-transcript"></div><div class="voice-transcript voice-answer"></div><div class="voice-facts"></div>';
  composer.querySelector('#input')!.before(region);
  const button=document.createElement('button');button.type='button';button.className='voice-start';button.title='语音对话：问进度或调整当前任务';button.setAttribute('aria-label','打开语音问进度');button.setAttribute('aria-expanded','false');
  button.innerHTML='<canvas aria-hidden="true"></canvas><span>语音</span>';
  composer.querySelector('#composer-spacer')!.after(button);
  const status=region.querySelector<HTMLElement>('.voice-state')!,end=region.querySelector<HTMLButtonElement>('.voice-end')!;
  const transcript=region.querySelector<HTMLElement>('.voice-answer')!,question=region.querySelector<HTMLElement>('.voice-question')!,facts=region.querySelector<HTMLElement>('.voice-facts')!;
  let phase:VoicePhase='idle';
  let shownTurn=0;
  let currentDeliveryKind: UserDelivery['kind'] | null = null;

  // 语音记录：正常语音自动留证（agent 落盘），这里保留手动复现、导出与清空，并提供一秒钟标记。
  // Frames arrive every 20ms; the block refreshes on a short throttle instead.
  let renderTimer:ReturnType<typeof setTimeout>|null=null;
  const scheduleDiag=():void=>{
    if(renderTimer)return;
    renderTimer=setTimeout(()=>{renderTimer=null;renderDiag()},200);
  };
  const log=new VoiceDiagnosticLog(scheduleDiag);
  const node=(tag:string,className?:string,text?:string):HTMLElement=>{
    const element=document.createElement(tag);if(className)element.className=className;if(text)element.textContent=text;return element;
  };
  const record=node('div','voice-record');
  const recordHead=node('div','voice-record-head');
  const markButton=node('button','voice-diag-mark','这条不对') as HTMLButtonElement;markButton.type='button';
  markButton.title='标记最近一轮：只记录，不打断说话，不改变语音状态';
  const markNote=node('span','voice-diag-mark-note','');
  markNote.setAttribute('role','status');
  recordHead.append(markButton,markNote);
  const diag=node('details','voice-diag') as HTMLDetailsElement;
  diag.appendChild(node('summary','voice-diag-summary','语音记录'));
  const diagBody=node('div','voice-diag-body');
  const diagState=node('div','voice-diag-state','');
  diagState.setAttribute('role','status');
  const actions=node('div','voice-diag-actions');
  const diagStart=node('button','voice-diag-start','开始录音') as HTMLButtonElement;diagStart.type='button';
  const diagStop=node('button','voice-diag-stop','结束录音') as HTMLButtonElement;diagStop.type='button';diagStop.disabled=true;
  const diagExport=node('button','voice-diag-export','导出JSON') as HTMLButtonElement;diagExport.type='button';
  const diagClear=node('button','voice-diag-clear','清空') as HTMLButtonElement;diagClear.type='button';
  actions.append(diagStart,diagStop,diagExport,diagClear);
  const diagList=node('div','voice-diag-list');
  const diagDetail=node('div','voice-diag-detail');
  const fields=new Map<string,HTMLElement>();
  for(const label of ['状态','连续收音 C0','实际上行 C1','原始转写（过滤前）','服务端转发','侧栏收到','侧栏显示文字','一致性','异常']){
    const row=node('div','voice-diag-row');
    const name=node('span','voice-diag-label',label);
    const value=node('span','voice-diag-value','');
    row.append(name,value);diagDetail.appendChild(row);fields.set(label,value);
  }
  const audioRow=node('div','voice-diag-audio');
  const loadC0=node('button','voice-diag-load-c0','载入C0') as HTMLButtonElement;loadC0.type='button';
  const loadC1=node('button','voice-diag-load-c1','载入C1') as HTMLButtonElement;loadC1.type='button';
  const playerC0=node('audio','voice-diag-player-c0') as HTMLAudioElement;playerC0.controls=true;playerC0.preload='none';
  const playerC1=node('audio','voice-diag-player-c1') as HTMLAudioElement;playerC1.controls=true;playerC1.preload='none';
  audioRow.append(loadC0,playerC0,loadC1,playerC1);
  diagBody.append(diagState,actions,diagList,diagDetail,audioRow);
  diag.appendChild(diagBody);
  record.append(recordHead,diag);
  composer.querySelector('#input')!.before(record);
  const audioUrls=new Map<string,string>();
  let diagNotice:{text:string;at:number}|null=null;
  const notice=(text:string):void=>{diagNotice={text,at:Date.now()};renderDiag();};
  const releaseAudio=():void=>{
    for(const url of audioUrls.values())URL.revokeObjectURL?.(url);
    audioUrls.clear();
    playerC0.removeAttribute?.('src');playerC1.removeAttribute?.('src');
  };
  const captureLine=(capture:VoiceDiagCapture):string=>{
    const seconds=(capture.samples/capture.sampleRate).toFixed(1);
    const status=log.status(capture);
    return `第${capture.turn}段 · ${seconds}秒 · ${status.complete?'完整':'未完成：'+status.reasons.join('、')}`;
  };
  const text=(value:string|null|undefined):string=>value&&value.trim()?value.trim():'（无）';
  function renderDiag():void{
    const latest=log.latest();
    // Idle retries stay available; while a session is open and unconfirmed the wait itself is the feedback.
    diagStart.disabled=client.diagnosticRecording||(client.active&&!log.isConfirmed);
    diagStop.disabled=!client.diagnosticRecording;
    diagState.textContent=diagNotice&&Date.now()-diagNotice.at<5000?diagNotice.text:!log.isDiagnostic
      ? '正常语音自动记录；手动复现未开启（点“开始录音”单独复现一条，期间不执行网页操作）。'
      : !log.isConfirmed
        ? '等待服务端确认诊断模式…（确认前不会发送任何音频）'
        : client.diagnosticRecording
          ? `录音中：${latest?(latest.samples/latest.sampleRate).toFixed(1):'0.0'} 秒 / 上限 ${log.limitSeconds} 秒`
          : '已确认：可继续录音，或结束等待本轮转写。';
    diagList.replaceChildren?.();
    const items=log.captures();
    if(!items.length)diagList.appendChild(node('div','voice-diag-empty','暂无记录。'));
    else for(const capture of items.slice(-4).reverse())diagList.appendChild(node('div','voice-diag-item',captureLine(capture)));
    if(!latest){for(const value of fields.values())value.textContent='';return;}
    const status=log.status(latest);const checks=log.checks(latest);
    fields.get('状态')!.textContent=status.complete?'完整':`未完成：${status.reasons.join('、')}`;
    fields.get('连续收音 C0')!.textContent=`${(latest.samples/latest.sampleRate).toFixed(1)} 秒 / ${latest.frames.length} 帧 / 采样率 ${latest.sampleRate}${latest.track?` / track ${latest.track.sampleRate}Hz ${latest.track.channelCount}ch`:' / track 未知'}`;
    const sent=latest.upstream.reduce((sum,entry)=>sum+entry.samples,0);
    fields.get('实际上行 C1')!.textContent=`${(sent/latest.sampleRate).toFixed(1)} 秒 / ${latest.upstream.length} 段${latest.itemId?` / item ${latest.itemId}`:' / 无 item'}${latest.commit?'': ' / 无 commit'}`;
    fields.get('原始转写（过滤前）')!.textContent=`${text(latest.rawAsr?.text)}（${latest.rawAsr?.outcome??'未收到'}${latest.rawAsr?.turn!=null?` / 第${latest.rawAsr.turn}段`:''}）`;
    fields.get('服务端转发')!.textContent=text(latest.forwarded?.text);
    fields.get('侧栏收到')!.textContent=text(latest.serverText?.text);
    fields.get('侧栏显示文字')!.textContent=text(latest.displayText?.text);
    fields.get('一致性')!.textContent=[
      checks.rawMatchesForward===null?'原始=转发: 未知':`原始=转发: ${checks.rawMatchesForward?'一致':'不一致'}`,
      checks.forwardMatchesServer===null?'转发=侧栏: 未知':`转发=侧栏: ${checks.forwardMatchesServer?'一致':'不一致'}`,
      checks.displayMatchesServer===null?'侧栏=显示: 未知':`侧栏=显示: ${checks.displayMatchesServer?'一致':'不一致'}`,
    ].join(' / ');
    fields.get('异常')!.textContent=latest.notes.length?latest.notes.map(note=>note.code+(note.detail?`(${note.detail})`:'')).join('、'):'（无）';
    loadC0.disabled=!latest.frames.length;
    loadC1.disabled=!log.c1Ready(latest);
  }
  const loadAudio=(which:'c0'|'c1'):void=>{
    const latest=log.latest();if(!latest)return;
    const blob=log.wav(latest.id,which);
    if(!blob){notice(which==='c1'?'这条记录的 C1 尚未完整，暂不可播放。':'这条记录的连续收音已释放。');return;}
    const previous=audioUrls.get(which);if(previous)URL.revokeObjectURL?.(previous);
    const url=URL.createObjectURL(blob);audioUrls.set(which,url);
    const player=which==='c0'?playerC0:playerC1;
    player.src=url;
    notice(`已载入 ${which.toUpperCase()}（点播放键试听）。`);
  };
  loadC0.onclick=()=>loadAudio('c0');
  loadC1.onclick=()=>loadAudio('c1');
  diagClear.onclick=()=>{releaseAudio();log.clear();notice('已清空本地记录与音频。')};
  diagExport.onclick=()=>{
    if(!log.captures().length){notice('暂无记录可导出。');return;}
    const blob=new Blob([log.exportJSON()],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a') as HTMLAnchorElement;
    link.href=url;link.download=`voice-diagnostic-${Date.now()}.json`;
    link.click?.();URL.revokeObjectURL?.(url);
  };
  diagStart.onclick=()=>{
    if(client.active&&!client.diagnosticMode){notice('普通语音正在使用，请先结束语音再开始诊断。');return;}
    if(client.active){const started=client.beginDiagnosticRecording();if(!started.ok)notice(started.detail??'暂时无法开始录音。');return;}
    void client.startDiagnostic(getConversation());
  };
  diagStop.onclick=()=>{
    if(!client.diagnosticRecording)return;
    log.displayText(question.textContent ?? '');
    notice('正在等待本轮转写…');
    client.finishDiagnostic();
  };
  // 一次点击完成：按钮只发一条标记命令，不弹输入、不打断录音、不停止语音、不改任何语音状态。
  markButton.onclick=()=>{
    const marked=client.markLatest();
    markNote.textContent=marked.ok?`已标记 ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`:(marked.detail??'标记未发送');
  };
  const client=new VoiceClient(send,(next,detail)=>{
    phase=next;
    if(client.diagnosticMode){region.hidden=true;button.setAttribute('aria-expanded','false');renderDiag();return;}
    region.hidden=next==='idle';button.setAttribute('aria-expanded',String(next!=='idle'));
    button.setAttribute('aria-label',next==='idle'?'打开语音问进度':'结束语音问进度');
    status.textContent=detail??({idle:'',connecting:'正在连接',listening:'正在听你说',thinking:'正在处理这句话',speaking:'正在回答',error:'连接失败'}[next]);
    if(next==='error' && client.needsMicrophonePermission)status.textContent='请在授权页开启麦克风，再回到这里重试。';
    end.textContent=next==='error'?(client.needsMicrophonePermission?'开启麦克风':'重试'):'结束';region.dataset.state=next;
  },event=>{
    if ('turn' in event && event.turn !== shownTurn) { shownTurn=event.turn; transcript.textContent='';question.textContent='';currentDeliveryKind=null; }
    if(event.kind==='text') {
      log.textEvent(event.role,event.turn,event.text);
      if(event.role==='user'){question.textContent='你：'+event.text;log.displayText(question.textContent??'',true);client.captureDisplay(event.turn,question.textContent??'');}
      else transcript.textContent=event.text;
    }
    if(event.kind==='facts')facts.textContent='依据当前任务状态 · '+new Date(event.snapshot.observedAt).toLocaleTimeString('zh-CN',{hour12:false});
  },getInput,(event,fields)=>{
    if (event.startsWith('voice_recover') || event === 'voice_reconnect_attempt') {
      console.info(`[voice] ${event}`, { event, turn: fields.turn, attempt: fields.attempt, at: fields.at });
    }
    diagnostic?.(event, fields);
  },log);
  renderDiag();
  const start=()=>{shownTurn=0;question.textContent='';transcript.textContent='';facts.textContent='';currentDeliveryKind=null;void client.start(getConversation());};
  const retry=async()=>{
    if(client.needsMicrophonePermission && await microphonePermissionState()!=='granted'){
      try { await chrome.tabs.create({url:chrome.runtime.getURL('voice-permission.html')}); }
      catch { status.textContent='无法打开授权页，请重新加载扩展后重试。'; }
      return;
    }
    start();
  };
  button.onclick=()=>client.active?client.stop():void retry();
  end.onclick=()=>phase==='error'?void retry():client.stop();
  window.addEventListener('focus',()=>{
    if(phase==='error' && client.needsMicrophonePermission)void microphonePermissionState().then(state=>{
      if(state==='granted' && phase==='error') {client.needsMicrophonePermission=false;end.textContent='重试';status.textContent='麦克风已授权，点击重试。';}
    });
  });
  const disposeSmall=mountOrb(button.querySelector('canvas')!,160,()=> 'idle');
  const disposeLarge=mountOrb(region.querySelector('canvas')!,160,()=>phase,()=>client.level);
  window.addEventListener('pagehide',()=>{if(renderTimer)clearTimeout(renderTimer);releaseAudio();client.stop();disposeSmall();disposeLarge();},{once:true});
  return {
    stop: () => client.stop(),
    disconnect: () => { if (client.active) client.onTransportDisconnected(); },
    reconnected: () => { client.onTransportReady(); },
    receive: (m: Extract<ServerMessage, { type: 'voice' }>) => client.receive(m),
    deliver: (delivery: { kind?: UserDelivery['kind']; text: string }) => {
      if (currentDeliveryKind === 'finding' || currentDeliveryKind === 'reply') {
        if (delivery.kind === 'ack') return;
      }
      if (delivery.kind) currentDeliveryKind = delivery.kind;
      transcript.textContent = delivery.text;
    }
  };
}
