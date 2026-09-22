import type {VoiceInputContext} from '../../shared/voice.js';

/**
 * Voice input identity: committed turns, late transcripts, playback-interrupt bookkeeping.
 * Does not own routing or task cancellation.
 */
export const LATE_TRANSCRIPT_MERGE_MS = 2500;

type InputContextRecord={input?:VoiceInputContext;error?:string;ready:boolean;wait:Promise<void>;finish:()=>void;timer?:ReturnType<typeof setTimeout>};

export class VoiceInputLedger {
  turn = 0;
  private committed = new Set<number>();
  private pendingLate = new Map<number,number>();
  private lateParts = new Map<number,string>();
  private contexts=new Map<number,InputContextRecord>();
  private utteranceContext:InputContextRecord|undefined;
  private utteranceContextTurn:number|undefined;
  private unfinished: {text:string;expiresAt:number} | null = null;

  prepareContext(turn:number,input:VoiceInputContext|undefined,pending=false):void {
    let finish!:()=>void;
    const wait=new Promise<void>(resolve=>finish=resolve);
    const record:InputContextRecord={input,ready:!pending,wait,finish};

    if(record.ready)finish();
    else record.timer=setTimeout(()=>{
      record.error='页面资料准备超时，这句话尚未执行。';record.ready=true;finish();
    },5000);
    this.contexts.set(turn,record);

    for(const [oldTurn,old] of this.contexts)if(oldTurn<turn-20){
      if(old.timer)clearTimeout(old.timer);old.finish();this.contexts.delete(oldTurn);
    }
  }

  supplyContext(turn:number,input?:VoiceInputContext,error?:string):void {
    const record=this.contexts.get(turn);

    if(!record||record.ready)return;
    record.input=input;record.error=error;record.ready=true;

    if(record.timer)clearTimeout(record.timer);record.finish();
  }

  resolveContext(turn:number):{input?:VoiceInputContext;error?:string}|Promise<{input?:VoiceInputContext;error?:string}> {
    const current=this.contexts.get(turn),source=this.utteranceContext??current;

    const finish=()=>{
      this.contexts.delete(turn);this.utteranceContext??=current;this.utteranceContextTurn??=turn;

      return {input:source?.input??current?.input,error:source?.error??current?.error};
    };

    if((!source||source.ready)&&(!current||current.ready))return finish();

    return Promise.all([source?.wait,current?.wait]).then(finish);
  }

  finishUtterance():void {this.utteranceContext=undefined;this.utteranceContextTurn=undefined;this.unfinished=null;}

  clear():void {
    for(const record of this.contexts.values()){if(record.timer)clearTimeout(record.timer);record.finish();}

    this.contexts.clear();this.finishUtterance();this.lateParts.clear();this.pendingLate.clear();
  }

  holdTranscript(text:string):void {
    this.unfinished={text:text.slice(0,12000),expiresAt:Date.now()+20000};
  }

  interrupt(nextTurn: number, answerWasCut: boolean): void {
    const cutOffTurn = this.turn;

    if(answerWasCut&&nextTurn===cutOffTurn+1){
      this.pendingLate.set(cutOffTurn,Date.now()+LATE_TRANSCRIPT_MERGE_MS);
    }else{this.pendingLate.clear();this.lateParts.clear();}

    this.turn = nextTurn;

    for(const [turn,expiry] of this.pendingLate)if(turn<nextTurn-20||Date.now()>expiry)this.pendingLate.delete(turn);
  }

  commit(turn: number): boolean {
    if (this.committed.has(turn)) return false;
    this.committed.add(turn);

    return true;
  }

  hasCommitted(turn: number): boolean {
    return this.committed.has(turn);
  }

  mergeLate(fromTurn: number, spoken: string, now = Date.now()): boolean {
    if (!spoken) return false;
    const expiry=this.pendingLate.get(fromTurn);

    if(expiry===undefined||now>expiry)return false;
    this.pendingLate.delete(fromTurn);

    if(this.utteranceContextTurn===undefined||fromTurn<this.utteranceContextTurn){
      this.utteranceContext=this.contexts.get(fromTurn);this.utteranceContextTurn=fromTurn;
    }

    this.lateParts.set(fromTurn,spoken);

    return true;
  }

  takeTranscript(spoken: string): string {
    // Noise must not consume a phrase the user is still composing.
    if(!spoken.trim()&&!this.lateParts.size)return '';
    const prefix=this.unfinished&&Date.now()<this.unfinished.expiresAt?this.unfinished.text:'';
    this.unfinished=null;
    const late=[...this.lateParts].sort(([a],[b])=>a-b).map(([,text])=>text).join(' ');
    const transcript = [prefix, late, spoken].filter(Boolean).join(" ").trim();
    this.lateParts.clear();this.pendingLate.clear();

    return transcript;
  }
}
