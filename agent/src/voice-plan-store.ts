import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {VoiceIntentError} from './voice-errors.js';
import {TaskActionRejected} from './task-dispatcher.js';
import type {VoiceRouteResult,VoiceInputContext} from '../../shared/voice.js';
import type {TaskReceipt} from '../../shared/task-actions.js';
export interface VoicePlanStep {action:string;text:string;targetId:string;targetTitle?:string;status:'unexecuted'|'pending'|'complete';receipt?:TaskReceipt}
export interface VoiceProposal {id:string;conversationId:string;voiceId:string;turn:number;expiresAt:number;text:string;input?:VoiceInputContext}
interface Record {id:string;source:string;fingerprint:string;steps:VoicePlanStep[];result?:VoiceRouteResult;proposal?:VoiceProposal}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const uncertain=():VoiceRouteResult=>({kind:'action',ok:false,status:'unknown',message:'这份语音计划的结果无法确认，请查询已有回执；不会重新分类或执行。'});
/** Claim before classification; step journal before effects; replay never resumes an unfinished plan. */
export class VoicePlanStore {
 private memory=new Map<string,Record>();
 private active=new Map<string,{fingerprint:string;promise:Promise<VoiceRouteResult>}>();
 constructor(private directory?:string){if(directory)mkdirSync(directory,{recursive:true,mode:0o700});}
 private key(source:string,id:string){return hash(`${source}:${id}`);}
 private read(key:string):Record|undefined{
  if(!this.directory)return this.memory.get(key);
  try{const r=JSON.parse(readFileSync(join(this.directory,`${key}.json`),'utf8'));if(!r||typeof r.id!=='string'||typeof r.fingerprint!=='string'||!Array.isArray(r.steps))throw Error('Invalid voice plan');return r;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 }
 private write(key:string,record:Record,claim=false):void{
  if(!this.directory){if(claim&&this.memory.has(key))throw Error('Plan exists');this.memory.set(key,structuredClone(record));return;}
  const file=join(this.directory,`${key}.json`);
  if(claim){writeFileSync(file,JSON.stringify(record),{flag:'wx',mode:0o600});return;}
  const temp=`${file}.${randomUUID()}.tmp`;
  try{writeFileSync(temp,JSON.stringify(record),{mode:0o600});renameSync(temp,file);}finally{rmSync(temp,{force:true});}
 }
 update(source:string,id:string,change:{steps?:VoicePlanStep[];proposal?:VoiceProposal}):void{
  const key=this.key(source,id),record=this.read(key);if(!record)throw Error('Plan not claimed');this.write(key,{...record,...change});
 }
 proposal(source:string,voiceId:string,turn:number):VoiceProposal|undefined{
  const records=this.directory?readdirSync(this.directory).filter(f=>f.endsWith('.json')).flatMap(f=>{try{return [this.read(f.slice(0,-5))!];}catch{return [];}}):[...this.memory.values()];
  return records.find(r=>r.source===source&&r.proposal?.voiceId===voiceId&&r.proposal.turn===turn&&r.proposal.expiresAt>Date.now())?.proposal;
 }
 private result(record:Record):VoiceRouteResult{return {...(record.result??uncertain()),plan:record.result?.plan??{id:record.id,conversationId:record.source,updatedAt:0,steps:record.steps}};}
 get(source:string,id:string):VoiceRouteResult|undefined{try{const record=this.read(this.key(source,id));return record?this.result(record):undefined;}catch{return uncertain();}}
 list(source:string):VoiceRouteResult[]{
  const records=this.directory?readdirSync(this.directory).filter(f=>f.endsWith('.json')).flatMap(f=>{try{return [this.read(f.slice(0,-5))!];}catch{return [];}}):[...this.memory.values()];
  return records.filter(r=>r.source===source&&r.steps.length>1).map(r=>this.result(r));
 }
 run(source:string,id:string,input:unknown,execute:()=>Promise<VoiceRouteResult>):Promise<VoiceRouteResult>{
  const key=this.key(source,id),fingerprint=hash(JSON.stringify(input));
  const conflict=():VoiceRouteResult=>({kind:'clarify',message:'同一语音计划编号的内容发生变化，本句未执行。'});
  const active=this.active.get(key);if(active)return active.fingerprint===fingerprint?active.promise:Promise.resolve(conflict());
  const promise=Promise.resolve().then(async()=>{
   let record:Record|undefined;
   try{record=this.read(key);}catch{return uncertain();}
   if(record)return record.fingerprint===fingerprint?this.result(record):conflict();
   try{this.write(key,{id,source,fingerprint,steps:[]},true);}catch{return uncertain();}
   try{
    const result=await execute();record=this.read(key)!;
    const plan={id,conversationId:source,updatedAt:Date.now(),steps:record.steps};const final={...result,plan};
    this.write(key,{...record,result:final});return final;
   }catch(error){
    // Preserve classifier errors for the caller while making a replay fail closed.
    try{record=this.read(key)!;this.write(key,{...record,result:uncertain()});}catch{/* original pending journal remains */}
    if(error instanceof VoiceIntentError||error instanceof TaskActionRejected)throw error;
    return record?{...uncertain(),plan:{id,conversationId:source,updatedAt:Date.now(),steps:record.steps}}:uncertain();
   }
  });
  this.active.set(key,{fingerprint,promise});void promise.finally(()=>this.active.delete(key)).catch(()=>{});return promise;
 }
}
