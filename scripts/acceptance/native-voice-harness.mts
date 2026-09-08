/** Shared real native-host harness; only test setup and observation use CDP. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker} from './cdp.mjs';
import {sideagentExtensionId} from './constants.mjs';
import type {VoiceInputContext} from '../../shared/voice.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export class NativeVoiceHarness {
  readonly ids:string[]=[];readonly tabs=new Set<number>();readonly checks:Array<{name:string;ok:boolean}>=[];
  voiceId='';turn=0;originConversation='';
  private targetId='';private pageSid='';private original='default';
  private constructor(readonly out:string,readonly connection:Awaited<ReturnType<typeof connectParentAcceptance>>){}
  static async open(title:string):Promise<NativeVoiceHarness>{
    const out=`/tmp/ego-${title}-${Date.now()}`;await mkdir(out,{recursive:true});const h=new NativeVoiceHarness(out,await connectParentAcceptance());
    try{
      h.original=await h.w(`chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId||'default')`);
      const q=randomUUID();await h.send({type:'conversation_list',requestId:q});const list=await h.wait(`(globalThis.__saServerEvents||[]).find(e=>e.type==='conversation_list'&&e.requestId===${JSON.stringify(q)})`);
      if(list.conversations.some((c:any)=>c.state==='running'))throw Error('Another native task is running; not taking over');
      const page=await h.connection.cdp.send('Target.createTarget',{url:`chrome-extension://${sideagentExtensionId()}/sidepanel.html`,background:true});h.targetId=page.targetId;h.pageSid=await h.connection.cdp.attachSession(h.targetId);
      for(let i=0;i<100;i++){if(await h.p('!!globalThis.chrome?.runtime'))break;await sleep(100);}
      await h.p(`globalThis.testPort=chrome.runtime.connect({name:'sideagent-panel'});testPort.onMessage.addListener(m=>{if(m.kind==='server'&&m.msg.type==='voice'&&m.msg.event.kind==='response_end')testPort.postMessage({kind:'client',msg:{type:'voice',voiceId:m.msg.voiceId,conversationId:m.msg.conversationId,command:{kind:'playback_done',responseId:m.msg.event.responseId}}});});`);
      return h;
    }catch(error){await h.close();throw error;}
  }
  async w(expression:string):Promise<any>{new Function(expression);return evaluateInWorker(this.connection.cdp,this.connection.sid,expression);}
  async p(expression:string):Promise<any>{new Function(expression);const r=await this.connection.cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},this.pageSid);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
  send(message:unknown){return this.w(`globalThis.__saSendClient(${JSON.stringify(message)})`);}
  async wait(expression:string,ms=60000):Promise<any>{const end=Date.now()+ms;while(Date.now()<end){const result=await this.w(expression);if(result)return result;await sleep(100);}throw Error(`Timed out: ${expression.slice(0,100)}`);}
  events(id:string){return `(globalThis.__saServerEvents||[]).filter(e=>e.conversationId===${JSON.stringify(id)})`;}
  receipts(id:string){return `${this.events(id)}.filter(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.receipt).map(e=>e.event.receipt)`;}
  check(name:string,ok:boolean){this.checks.push({name,ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);}
  async create(title:string):Promise<string>{
    const q=randomUUID();await this.send({type:'conversation_create',requestId:q,title});const event=await this.wait(`(globalThis.__saServerEvents||[]).find(e=>e.type==='conversation_created'&&e.requestId===${JSON.stringify(q)})`);
    const id=event.conversation.id;this.ids.push(id);await this.send({type:'set_model',conversationId:id,model:'minimax-cn/MiniMax-M3'});
    await this.wait(`${this.events(id)}.some(e=>e.type==='model_info'&&e.model==='minimax-cn/MiniMax-M3')`);return id;
  }
  async listen(id:string){
    await this.p(`testPort.postMessage(${JSON.stringify({kind:'select_conversation',conversationId:id})})`);await sleep(150);
    this.voiceId=randomUUID();this.turn=0;this.originConversation=id;
    await this.voice({kind:'start'});await this.wait(`${this.events(id)}.some(e=>e.type==='voice'&&e.voiceId===${JSON.stringify(this.voiceId)}&&e.event.kind==='state'&&e.event.state==='ready')`,20000);
  }
  voice(command:unknown){return this.p(`testPort.postMessage(${JSON.stringify({kind:'client',msg:{type:'voice',voiceId:this.voiceId,conversationId:this.originConversation,command}})})`);}
  async speak(text:string,input?:VoiceInputContext,quiet=false){
    const turn=++this.turn,base=`${this.out}/${turn}-${createHash('sha256').update(text).digest('hex').slice(0,8)}`;
    execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',base+'.aiff',text]);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
    const audio=Buffer.concat([await readFile(base+'.pcm'),Buffer.alloc(24000)]);await this.voice({kind:'interrupt',turn});
    for(let i=0;i<audio.length;i+=4800){await this.voice({kind:'audio',turn,data:audio.subarray(i,i+4800).toString('base64')});await sleep(100);}
    await this.voice({kind:'commit',turn,...(input?{input}:{})});
    const source=`${this.events(this.originConversation)}.filter(e=>e.type==='voice'&&e.voiceId===${JSON.stringify(this.voiceId)})`;
    if(quiet)await this.wait(`(()=>{const es=${source};const i=es.findIndex(e=>e.event.kind==='text'&&e.event.role==='user'&&e.event.turn===${turn});return i>=0&&es.slice(i+1).some(e=>e.event.kind==='state'&&e.event.state==='ready');})()`,50000);
    else {const response=await this.wait(`${source}.find(e=>e.event.kind==='response_end'&&e.event.turn===${turn}||e.event.kind==='state'&&e.event.state==='error')`,55000);if(response.event.kind==='state')throw Error(response.event.detail);}
    return turn;
  }
  async openTab(id:string,url:string,worker='main'){
    const r=await this.connection.tool(id,worker,'open_tab',{url});if(!r.ok)throw Error(r.error);this.tabs.add(r.data.tabId);return r.data;
  }
  async finishReport(data:unknown){await writeFile(`${this.out}/result.json`,JSON.stringify({checks:this.checks,...data as any},null,2));}
  async close(){
    if(this.voiceId)await this.voice({kind:'stop'}).catch(()=>{});
    for(const id of this.ids){
      const current=await this.w(`${this.events(id)}.filter(e=>e.type==='conversation_updated').at(-1)?.conversation`).catch(()=>null);
      if(current?.runId&&['running','user'].includes(current.state)){
        const requestId=randomUUID();await this.send({type:'task_action',conversationId:id,request:{requestId,conversationId:id,source:'text',action:'abort',expectedRunId:current.runId}}).catch(()=>{});
        await this.wait(`${this.receipts(id)}.find(r=>r.requestId===${JSON.stringify(requestId)})`,50000).catch(()=>{});
      }
    }
    if(this.pageSid)await this.p(`testPort.postMessage(${JSON.stringify({kind:'select_conversation',conversationId:this.original})})`).catch(()=>{});
    for(const id of this.tabs)await this.w(`chrome.tabs.remove(${id}).catch(()=>{})`).catch(()=>{});
    if(this.targetId)await this.connection.cdp.send('Target.closeTarget',{targetId:this.targetId}).catch(()=>{});
    await this.connection.close();
  }
}
