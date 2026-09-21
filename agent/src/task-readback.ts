import {resultHasWriteEffect} from '../../shared/task-results.js';
import type {TaskProgressSnapshot} from '../../shared/voice.js';

/** Ordering and scope of post-action observations, not a semantic success verifier. */
export class TaskReadback {
  private revision=0;
  private readonly pages=new Map<string,number>();
  private readonly required=new Map<string,{member:string;tabId:number|null;revision:number}>();
  private readonly closed=new Map<string,{member:string;tabId:number|null;revision:number}>();
  private overflow=false;

  reset():void { this.revision=0;this.pages.clear();this.required.clear();this.closed.clear();this.overflow=false; }
  needsReadback():boolean { return this.overflow||this.required.size>0||this.closed.size>0; }
  version():number { return this.revision; }
  beginWrite():void { this.revision++; }
  restore(snapshot:TaskProgressSnapshot):void {
    this.reset();
    for(const item of snapshot.results??[]){
      if(item.status==='satisfied'&&resultHasWriteEffect(item))this.written(item.evidence?.member??'main',null);
    }
    // Old hosts did not record auxiliary mutations as result items. Retain their
    // pending review conservatively, but never reuse a saved observation as fresh.
    if(snapshot.nextStep?.reason==='readback_required'&&!this.required.size)this.written('main',null);
  }
  pageFor(member:string,tabId?:number):number|null { return tabId??this.pages.get(member)??null; }
  forgetPage(member:string):void { this.pages.delete(member); }
  closedTab(member:string,tabId:number|null):void {
    this.revision++;
    if(this.closed.size>=100){this.overflow=true;return;}
    this.closed.set(`${member}:${tabId??'unknown'}`,{member,tabId,revision:this.revision});
    if(this.pages.get(member)===tabId)this.pages.delete(member);
  }
  observedTabs(member:string,tabIds:readonly number[],readVersion:number):void {
    for(const [key,closed] of this.closed){
      if(closed.member===member&&closed.tabId!==null&&closed.revision<=readVersion&&!tabIds.includes(closed.tabId))this.closed.delete(key);
    }
  }
  written(member:string,tabId:number|null):void {
    this.revision++;
    const key=`${member}:${tabId??'working'}`;
    if(this.required.size>=100&&!this.required.has(key)){this.overflow=true;return;}
    this.required.set(key,{member,tabId,revision:this.revision});
  }
  observed(member:string,observation:{tabId:number|null;workingTab:boolean;truncated:boolean;text:string},readVersion:number):void {
    if(observation.tabId===null||observation.truncated)return;
    if(observation.workingTab&&this.pages.size<100)this.pages.set(member,observation.tabId);
    for(const [key,write] of this.required){
      if(write.member!==member||write.revision>readVersion)continue;
      if(write.tabId===null?observation.workingTab:write.tabId===observation.tabId)this.required.delete(key);
    }
  }
  /** An actual successful unknown-result check is itself a scoped post-write read. */
  verified(member:string,tabId:number):void { this.observed(member,{tabId,workingTab:true,truncated:false,text:'verified'},this.revision); }
}
