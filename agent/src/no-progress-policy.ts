import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {isWriteTool} from '../../shared/control.js';
import {toolAction} from '../../shared/user-facing.js';

/**
 * 原地转圈的自停（docs/evals/20261001-data-to-file.md 标准 7）。
 *
 * 一次任务里，每个工具结果归三类：
 * - 有进展（清零）：真实动作（写类工具、程序里的写类步骤；`js`/`cdp` 按结果判断，因为它们多半只是读）、
 *   给用户的正式交付、文件的新建/修改/删除，或结果里有足够多这次任务没见过的内容片段；
 * - 没进展（+1）：成功但几乎全是已见过的片段（重读同一份数据、重看同一份目标清单、读回自己写的文件），
 *   或错误文字已经见过（换了参数也算同一个错误）；
 * - 记半步：中间等待过（sleep/waitFor/waitForLoad 后）读到的同样内容：正常等待给加倍的余量，但不会无限等下去；
 * - 不计：第一次出现的错误（模型刚碰到环境限制）。
 * 累计满 NO_PROGRESS_LIMIT 步没进展就停下本轮。门槛按 10-01 B 站记录回放定，见验收文件的回放表。
 */
export const NO_PROGRESS_LIMIT = 6;

/** 新片段至少占结果片段的这个比例才算新信息：同一份数据重切重读只多出 ≤0.51% 的边界碎片（10-01 记录）。 */
export const NOVELTY_MIN_SHARE = 0.02;

/** 一次任务最多记这么多不同片段，防止长任务把内存吃满；超过后不再记新片段（只会更不容易停）。 */
const SEEN_MAX = 200_000;

/** 结果里每次都会变、却不带新信息的字段：UUID、ISO 时间、长十六进制、毫秒时间戳与长编号。 */
const VOLATILE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\d{4}-\d\d-\d\dT[\d:.]+Z?/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\d{10,}/g,
];

/** 结果文字 → 内容片段：去掉 JSON 转义层，抹掉易变字段，按换行与 JSON 标点切开。 */
export function resultSegments(text:string):Set<string> {
  let plain=text.replace(/\\+n/g,'\n').replace(/\\+(["\\/])/g,'$1').replace(/\\+/g,'');

  for(const pattern of VOLATILE)plain=plain.replace(pattern,'#');

  return new Set(plain.split(/[\n\r"{}[\],]+/).map(part=>part.trim()).filter(Boolean));
}

/** 结果里有 `browser.saveFile` 的回执（去掉转义后按回执形状找）。 */
function hasSaveReceipt(text:string):boolean {
  return /"filename":"[^"]{1,120}","chars":\d+/.test(text.replace(/\\+(["\\/])/g,'$1'));
}

const FILE_CHANGES=new Set(['create','update','rewrite','delete']);

/** 只读居多的写类工具：结果里没新东西就不算进展。 */
const READ_LIKE_WRITES=new Set(['js','cdp']);

function isEffectStep(name:string,error?:string):boolean {
  return !error&&isWriteTool(name)&&!READ_LIKE_WRITES.has(name);
}

export interface NoProgressStop {toolName:string;streak:number}

export class NoProgressPolicy {
  private seen=new Set<string>();
  private streak:string[]=[];
  /** 累计步数：等待后的同样读数记半步。 */
  private weight=0;
  private steps=new Map<string,{effect:boolean;waited:boolean}>();
  private stopped=false;
  constructor(private readonly onStop:(stop:NoProgressStop)=>void) {}

  reset():void {this.seen.clear();this.streak=[];this.weight=0;this.steps.clear();this.stopped=false;}

  /** browser_run 里的步骤：写类步骤是真实动作，等待步骤说明这是有意的轮询。 */
  noteProgramStep(step:{parentId:string;name:string;phase:string;error?:string}):void {
    if(step.phase!=='end')return;
    const entry=this.steps.get(step.parentId)??{effect:false,waited:false};

    if(isEffectStep(step.name,step.error))entry.effect=true;

    if(/^(sleep|wait)/i.test(step.name))entry.waited=true;
    this.steps.set(step.parentId,entry);
  }

  private remember(segments:Iterable<string>):void {
    for(const segment of segments){if(this.seen.size>=SEEN_MAX)return;this.seen.add(segment);}
  }

  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_result',(event,ctx)=>{
        if(this.stopped)return;
        const text=event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const input=event.input;
        const step=this.steps.get(event.toolCallId)??{effect:false,waited:false};
        this.steps.delete(event.toolCallId);
        const fileChange=event.toolName==='artifacts'&&!event.isError&&FILE_CHANGES.has(String(input.command));

        // 自己写进文件的内容不是新信息：之后读回它不算进展。
        if(fileChange&&input.content!==undefined)this.remember(resultSegments(String(input.content)));
        // 程序里存了文件（哪怕同名同大小覆盖）也是改动了文件。
        const programSaved=!event.isError&&hasSaveReceipt(text);
        const segments=resultSegments(text);
        let fresh=0;

        for(const segment of segments)if(!this.seen.has(segment))fresh+=1;
        this.remember(segments);
        const novel=fresh>0&&fresh>=segments.size*NOVELTY_MIN_SHARE;
        const effect=!event.isError&&(isEffectStep(event.toolName)||event.toolName==='send_user_message'||fileChange||programSaved||step.effect);

        if(effect||(novel&&!event.isError)){this.streak=[];this.weight=0;

return;}

        // 第一次出现的错误：不算进展，也不算原地打转。
        if(novel)return;
        this.streak.push(event.toolName);
        this.weight+=step.waited||/^(sleep|wait)/.test(event.toolName)?0.5:1;

        if(this.weight<NO_PROGRESS_LIMIT)return;
        this.stopped=true;
        this.onStop({toolName:mostFrequent(this.streak),streak:this.streak.length});
        ctx.abort();
      });
    };
  }
}

function mostFrequent(names:string[]):string {
  const counts=new Map<string,number>();

  for(const name of names)counts.set(name,(counts.get(name)??0)+1);

  return [...counts].reduce((best,item)=>item[1]>=best[1]?item:best)[0];
}

export interface NoProgressFacts {
  toolName:string;
  streak:number;
  files:Array<{filename:string;chars?:number;lines?:number}>;
  /** 宿主核对过的目标。 */
  satisfied:string[];
  /** 这次任务最近一次目标核对说还差的事；没核对过为 null。 */
  missing:string|null;
  /** 列了但没核对过的目标：只能说没确认，不能说没做。 */
  unverified:string[];
}

export interface NoProgressMessage {text:string;unfinished:string[]}

/** 停下时给用户的一段话：卡在哪一步、已有什么、还差什么。 */
export function noProgressMessage(facts:NoProgressFacts):NoProgressMessage {
  const head=`「${toolAction(facts.toolName)}」这一步在原地打转：连续 ${facts.streak} 步都是重读已经拿到的内容或重复同样的错误，没有新进展，我先停下了。`;

  const have=[
    ...facts.files.map(file=>`文件「${file.filename}」${file.chars===undefined?'':`（${file.chars} 字${file.lines===undefined?'':`，${file.lines} 行`}）`}`),
    ...facts.satisfied.map(goal=>`已核对完成「${goal}」`),
  ];

  const tail=facts.missing?`还差：${facts.missing}。`:facts.unverified.length?`还没确认完成：${facts.unverified.join('、')}。`:'';
  const unfinished=facts.missing?[facts.missing]:facts.unverified;

  return {text:`${head}已有：${have.length?have.join('、'):'还没有生成文件或核对完成的结果'}。${tail}`,unfinished};
}
