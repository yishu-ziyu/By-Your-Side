import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {GOAL_CHECK_BOOKKEEPING_TOOLS} from './goal-check.js';

/**
 * 一次请求做了太久还没回话：用户在干等。用户自己的记录里，做成的请求都在 90 秒内交出第一版回答，
 * 超过 3 分钟才交的一次都没做成，最长的让用户等了 12 分钟。
 *
 * 到点后，在下一条工具结果后面写明：停下来，把找到的和卡在哪交给用户，问要不要接着试。
 * 之后再调工具只放行两次（收尾时存文件、补一眼），再多就挡下，直到它回话；交付和记账类工具不算。
 * 用户发新请求、插话或点继续时重新计时；核对后自动接着做的那一轮不重新计时。
 */
const CHECK_IN_AFTER_MS = 3 * 60_000;

const GRACE_CALLS = 2;

const DELIVERY_TOOLS = new Set([...GOAL_CHECK_BOOKKEEPING_TOOLS, 'artifacts']);

const checkIn = (minutes:number) => `[Time] ${minutes} minutes on this request and the user is still waiting. Stop exploring. Reply to the user now: what you found (with sources), what blocked you, and ask whether to keep trying. Call no more tools except to save or deliver what you already have.`;

export class RunClock {
  private startedAt:number;
  /** 提醒之后又调了几次工具；还没提醒为 null。 */
  private callsAfter:number|null=null;

  constructor(private readonly now:() => number = Date.now) {
    this.startedAt=now();
  }

  reset():void {this.startedAt=this.now();this.callsAfter=null;}
  resumeActive(activeMs: number): void { this.startedAt = this.now() - activeMs; this.callsAfter = null; }

  private minutes():number {return Math.max(1, Math.round((this.now()-this.startedAt)/60_000));}

  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_call',event=>{
        if(this.callsAfter===null||DELIVERY_TOOLS.has(event.toolName))return;
        this.callsAfter+=1;

        if(this.callsAfter<=GRACE_CALLS)return;

        return {block:true, reason:`Not run. ${checkIn(this.minutes())}`};
      });
      pi.on('tool_result',event=>{
        if(event.parentToolCallId||this.callsAfter!==null||this.now()-this.startedAt<CHECK_IN_AFTER_MS)return;
        this.callsAfter=0;

        return {content:[...event.content, {type:'text' as const, text:`\n${checkIn(this.minutes())}`}]};
      });
    };
  }
}
