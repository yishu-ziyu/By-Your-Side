import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';

/**
 * 长任务定期提醒汇报进展。耗时本身不能证明没有进展；停滞由 NoProgressPolicy 判断，
 * 不能因为用户等得久就禁止剩余操作，让用户反复点击继续。
 */
const CHECK_IN_AFTER_MS = 3 * 60_000;

const checkIn = (minutes:number) => `[Time] ${minutes} minutes on this request. Give a brief progress update, then continue the remaining authorized work. Elapsed time is not a reason to stop or ask whether to continue. Do not repeat completed steps.`;

export class RunClock {
  private startedAt:number;
  private remindedAt:number;

  constructor(private readonly now:() => number = Date.now) {
    this.startedAt=this.remindedAt=now();
  }

  reset():void {this.startedAt=this.remindedAt=this.now();}
  resumeActive(activeMs: number): void { this.startedAt = this.now() - activeMs; this.remindedAt = this.startedAt; }

  private minutes():number {return Math.max(1, Math.round((this.now()-this.startedAt)/60_000));}

  reminder():string|undefined {
    if(this.now()-this.remindedAt<CHECK_IN_AFTER_MS)return;
    this.remindedAt=this.now();
    return checkIn(this.minutes());
  }

  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_result',event=>{
        if(event.parentToolCallId)return;
        const reminder=this.reminder();
        if(!reminder)return;

        return {content:[...event.content, {type:'text' as const, text:`\n${reminder}`}]};
      });
    };
  }
}
