import { microphonePermissionState } from "./voice-permission.js";
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.js';
import { VoiceClient, type VoicePhase } from './voice-client.js';
import { mountOrb } from './voice-orb.js';
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
  const client=new VoiceClient(send,(next,detail)=>{
    phase=next;region.hidden=next==='idle';button.setAttribute('aria-expanded',String(next!=='idle'));
    button.setAttribute('aria-label',next==='idle'?'打开语音问进度':'结束语音问进度');
    status.textContent=detail??({idle:'',connecting:'正在连接',listening:'正在听你说',thinking:'正在处理这句话',speaking:'正在回答',error:'连接失败'}[next]);
    if(next==='error' && client.needsMicrophonePermission)status.textContent='请在授权页开启麦克风，再回到这里重试。';
    end.textContent=next==='error'?(client.needsMicrophonePermission?'开启麦克风':'重试'):'结束';region.dataset.state=next;
  },event=>{
    if ('turn' in event && event.turn !== shownTurn) { shownTurn=event.turn; transcript.textContent='';question.textContent='';currentDeliveryKind=null; }
    if(event.kind==='text') { if(event.role==='user')question.textContent='你：'+event.text;else transcript.textContent=event.text; }
    if(event.kind==='facts')facts.textContent='依据当前任务状态 · '+new Date(event.snapshot.observedAt).toLocaleTimeString('zh-CN',{hour12:false});
  },getInput,(event,fields)=>{
    if (event.startsWith('voice_recover') || event === 'voice_reconnect_attempt') {
      console.info(`[voice] ${event}`, { event, turn: fields.turn, attempt: fields.attempt, at: fields.at });
    }
    diagnostic?.(event, fields);
  });
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
  window.addEventListener('pagehide',()=>{client.stop();disposeSmall();disposeLarge();},{once:true});
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
