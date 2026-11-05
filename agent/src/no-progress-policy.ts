import { createHash } from 'node:crypto';
import { GOAL_CHECK_BOOKKEEPING_TOOLS } from './goal-check.js';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import { isWriteTool } from '../../shared/effect-policy.js';
import {toolAction} from '../../shared/user-facing.js';

const NO_PROGRESS_LIMIT = 15;

const NOVELTY_MIN_SHARE = 0.02;

const SEEN_MAX = 200_000;

const VOLATILE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\d{4}-\d\d-\d\dT[\d:.]+Z?/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\d{10,}/g,
];

function resultSegments(text:string):Set<string> {
  let plain=text.replace(/\\+n/g,'\n').replace(/\\+(["\\/])/g,'$1').replace(/\\+/g,'');

  for(const pattern of VOLATILE)plain=plain.replace(pattern,'#');

  return new Set(plain.split(/[\n\r"{}[\],]+/).map(part=>part.trim()).filter(Boolean));
}

function hasSaveReceipt(text:string):boolean {
  return /"filename":"[^"]{1,120}","chars":\d+/.test(text.replace(/\\+(["\\/])/g,'$1'));
}

const FILE_CHANGES=new Set(['create','update','rewrite','delete']);

const READ_LIKE_WRITES=new Set(['js','cdp']);

function isEffectStep(name:string,error?:string):boolean {
  return !error&&isWriteTool(name)&&!READ_LIKE_WRITES.has(name);
}

interface NoProgressStop {toolName:string;streak:number}

export class NoProgressPolicy {
  private seen=new Set<string>();
  private streak:string[]=[];
  private weight=0;
  private steps=new Map<string,{effect:boolean;waited:boolean}>();
  private stopped=false;
  private evidenceVersion=0;
  get progressVersion():number {return this.evidenceVersion;}
  get hasStopped():boolean {return this.stopped;}
  constructor(private readonly onStop:(stop:NoProgressStop)=>void) {}

  reset():void {this.seen.clear();this.streak=[];this.weight=0;this.steps.clear();this.stopped=false;this.evidenceVersion=0;}

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
      pi.on('agent_start',()=>{this.stopped=false;this.streak=[];this.weight=0;});
      pi.on('tool_result',(event,ctx)=>{
        if(this.stopped)return;
        const details:unknown=event.details;
        const refusal=details&&typeof details==='object'&&'repeatedParameterFailure' in details&&typeof details.repeatedParameterFailure==='string'?details.repeatedParameterFailure:null;
        const text=refusal??event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const input=event.input;
        const step=this.steps.get(event.toolCallId)??{effect:false,waited:false};
        this.steps.delete(event.toolCallId);
        const fileChange=event.toolName==='artifacts'&&!event.isError&&FILE_CHANGES.has(String(input.command));

        if(fileChange&&input.content!==undefined)this.remember(resultSegments(String(input.content)));
        const programSaved=!event.isError&&hasSaveReceipt(text);
        const segments=resultSegments(text);
        let fresh=0;

        for(const segment of segments)if(!this.seen.has(segment))fresh+=1;
        this.remember(segments);
        let newImage=false;
        for(const part of event.content){
          if(part.type!=='image')continue;
          const key='image:'+createHash('sha256').update(part.mimeType).update(part.data).digest('hex');
          if(!this.seen.has(key))newImage=true;
          this.remember([key]);
        }
        const novel=newImage||fresh>0&&fresh>=segments.size*NOVELTY_MIN_SHARE;
        if(novel&&!event.isError&&!GOAL_CHECK_BOOKKEEPING_TOOLS.has(event.toolName))this.evidenceVersion++;
        const effect=!event.isError&&(isEffectStep(event.toolName)||event.toolName==='send_user_message'||fileChange||programSaved||step.effect);

        if(effect||(novel&&!event.isError)){this.streak=[];this.weight=0;

return;}

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

interface NoProgressFacts {
  toolName:string;
  streak:number;
  files:Array<{filename:string;chars?:number;lines?:number}>;
  satisfied:string[];
  missing:string|null;
  unverified:string[];
}

interface NoProgressMessage {text:string;unfinished:string[]}

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
