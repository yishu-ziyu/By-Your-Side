import {VOICE_DIAG_MAX_SECONDS,VOICE_DIAG_SAMPLE_RATE,type VoiceDiagGapCode,type VoiceDiagRecord} from "../../shared/voice.js";

/**
 * Upstream evidence for one voice session.
 * Recording (`capture`) is deliberately separate from locking the session down (`blocking`):
 * a normal voice session records while answering and routing exactly as before, and only the
 * explicit manual diagnostic mode additionally refuses to route, answer or touch pages.
 * Records are emitted only from the real send path, after `socket.send` accepted the event;
 * a prepared-but-unsent frame is never recorded as C1.
 */
export class VoiceDiagnosticTrace {
  private seq=0;
  /** Item ids stay attributable to their turn for the whole session, even after the live turn moved on. */
  private readonly itemTurns=new Map<string,number>();
  constructor(
    private readonly capture:boolean,
    /** Manual diagnostic mode changes behavior; capture alone never does. */
    private readonly lockActions:boolean,
    private readonly emit:(record:VoiceDiagRecord)=>void,
    private readonly maxSeconds=VOICE_DIAG_MAX_SECONDS) {}
  /** Recording is on. This is not permission to change what the session does. */
  get active():boolean { return this.capture; }
  /** Manual diagnostic mode: no routing, no answers, no page actions, fail closed on transport loss. */
  get blocking():boolean { return this.lockActions; }
  get maxSamples():number { return Math.floor(this.maxSeconds*VOICE_DIAG_SAMPLE_RATE); }
  ready():void {
    if(!this.capture)return;
    this.emit({type:'ready',sampleRate:VOICE_DIAG_SAMPLE_RATE,maxSeconds:this.maxSeconds});
  }
  /** `audio` is the exact base64 payload the socket accepted; `frame` only aligns it with the continuous capture. */
  appendSent(eventId:string,turn:number,frame:number|null,audio:string,bytes:number):void {
    if(!this.capture)return;
    this.emit({type:'append',seq:++this.seq,eventId,turn,frame,samples:Math.floor(bytes/2),audio});
  }
  commitSent(eventId:string,turn:number):void {
    if(!this.capture)return;
    this.emit({type:'commit',seq:++this.seq,eventId,turn});
  }
  /** Upstream confirmation; the item id is what the provider committed, not a client guess. */
  item(turn:number,itemId:string):void {
    if(!this.capture)return;
    this.itemTurns.set(itemId,turn);
    this.emit({type:'item',turn,itemId});
  }
  /**
   * Raw ASR before the old-turn filter. The turn comes from this session's own item map, so a late
   * transcript of a superseded turn still reports its original turn instead of looking unattributable.
   */
  asr(itemId:string,text:string,currentTurn:number,empty:boolean):void {
    if(!this.capture)return;
    const turn=this.itemTurns.get(itemId)??null;
    this.emit({type:'asr',turn,itemId,outcome:turn===null?'unknown':turn!==currentTurn?'filtered':empty?'empty':'current',text});
  }
  /** Emitted only after the real user text event was forwarded for this turn. */
  forward(turn:number,itemId:string,text:string):void {
    if(!this.capture)return;
    this.emit({type:'forward',turn,itemId,text});
  }
  gap(code:VoiceDiagGapCode,turn:number|null,detail?:string):void {
    if(!this.capture)return;
    this.emit({type:'gap',code,turn,...(detail?{detail}:{})});
  }
  /** An over-length take is reported as truncated; it is never presented as a complete record. */
  overLimit(bytes:number):boolean { return this.capture&&bytes>this.maxSamples*2; }
}
