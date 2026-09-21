import { createHash } from 'node:crypto';
import { redactCredentialText } from '../../shared/untrusted.js';
import { isPageTextEvidence, type PageTextEvidence } from '../../shared/page-text-evidence.js';

/** Single-material character cap shared by capture and checkpoint restore. A whole document over this limit is a known limitation, not a bug. */
export const MATERIAL_VALUE_MAX = 8000;

export interface TaskObservation {
  id: string; runId: string; revision: string; tabId: number; url?: string;
  text: string; protectedFragmentIds?:string[]; fragments?:PageTextEvidence; truncated: boolean; at: number;
}
export interface ObservedMaterial {
  id: string; purpose: string; value: string; source: 'observed';
  observation: Omit<TaskObservation, 'text' | 'fragments' | 'protectedFragmentIds'>; selection: {kind:'text';spans:Array<{start:number;end:number}>} | {kind:'fragments';ids:string[]};
  verification?: { goalId:string; revision:string; criterion:string; description:string; probability:number; at:number; reviewedBy?:'jev'|'main' };
}

/** Observations expire in memory; only deliberately selected source text is persisted. */
export class TaskEvidence {
  private observations: TaskObservation[] = [];
  private materials: ObservedMaterial[] = [];

  observe(value: TaskObservation): void {
    if (value.text.length > 100000 || !value.runId || !value.revision || value.tabId <= 0) return;
    const safe=redactObservedText(value.text),protectedFragmentIds:string[]=[];
    const fragments=value.fragments?{...value.fragments,fragments:value.fragments.fragments.map(fragment=>{
      const filtered=redactObservedText(fragment.text);
      if(filtered.redacted)protectedFragmentIds.push(fragment.id);
      return {...fragment,text:filtered.text};
    })}:undefined;
    const observed={...value,text:safe.text,truncated:value.truncated||safe.redacted,fragments,...(protectedFragmentIds.length?{protectedFragmentIds}:{})};
    this.observations = [...this.observations.filter(o => o.id !== value.id), structuredClone(observed)].slice(-12);
  }
  list(runId: string, revision: string) {
    return {
      observations: this.observations.filter(o => o.runId === runId).map(({ text, fragments, ...o }) => ({ ...o, historical:o.revision!==revision, length: text.length, fragmentCount:fragments?.fragments.length??0, fragmentsTruncated:fragments?.truncated })),
      materials: this.materials.filter(m => m.observation.runId === runId).map(m => structuredClone(m)),
    };
  }
  read(id: string, runId: string): TaskObservation {
    const found = this.observations.find(o => o.id === id && o.runId === runId);
    if (!found) throw new Error('这份页面观察不属于当前任务或已过期，请读取当前页面。');
    return structuredClone(found);
  }
  prepare(id: string, purpose: string, observation: TaskObservation, spans: Array<{start:number;end:number}>): ObservedMaterial {
    if (observation.truncated) throw new Error('页面观察被截断，先取得完整来源再保存原文材料。');
    if (!spans.length || spans.length > 128) throw new Error('材料选取范围无效');
    let previousEnd = -1;
    for (const span of spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.start < previousEnd || span.end <= span.start || span.end > observation.text.length) throw new Error('材料范围无效或重叠');
      previousEnd = span.end;
    }
    const value = spans.map(s => observation.text.slice(s.start, s.end)).join('\n');
    return this.material(id,purpose,value,observation,{kind:'text',spans:structuredClone(spans)});
  }
  prepareFragments(id: string, purpose: string, observation: TaskObservation, firstId: string, lastId: string): ObservedMaterial {
    const raw=observation.fragments;
    if (!isPageTextEvidence(raw)||raw.truncated) throw new Error('原文片段不完整，请取得目标范围的完整来源');
    const first=raw.fragments.findIndex(f=>f.id===firstId), last=raw.fragments.findIndex(f=>f.id===lastId);
    if (first<0||last<first) throw new Error('来源片段范围无效');
    const selected=raw.fragments.slice(first,last+1), value=selected.map(f=>f.text).join('');
    if(selected.some(fragment=>observation.protectedFragmentIds?.includes(fragment.id)))throw new Error('所选原文含已隐去的凭据，不能把遮蔽内容当成完整原文复制');
    return this.material(id,purpose,value,observation,{kind:'fragments',ids:selected.map(f=>f.id)});
  }
  private material(id:string,purpose:string,value:string,observation:TaskObservation,selection:ObservedMaterial['selection']):ObservedMaterial {
    if(!id.trim()||id.length>64||!purpose.trim()||purpose.length>500)throw new Error('材料标识或用途无效');
    if(!value.trim())throw new Error('所选范围为空，请重新选择包含正文的范围');
    if(value.length>MATERIAL_VALUE_MAX)throw new Error(`所选范围共 ${value.length} 字符，超过单份原文预算上限 ${MATERIAL_VALUE_MAX} 字符。只保存用户实际要求的这一段；如果这份来源只是内部方法的中间步骤（不是用户明确要求的内容），改用 task_goals 的 plan 动作并带上 reason 修订目标方案，移除这个内部来源目标。`);
    const {text:_,fragments:_fragments,protectedFragmentIds:_protected,...source}=observation;
    return {id,purpose,value,source:'observed',observation:source,selection};
  }
  canonicalMaterial(material:ObservedMaterial):ObservedMaterial {
    const existing=this.materials.find(item=>item.observation.runId===material.observation.runId&&item.id===material.id);
    if(!existing||this.sameSource(existing,material))return material;
    const suffix=createHash('sha256').update(JSON.stringify({observation:material.observation,selection:material.selection,value:material.value})).digest('hex').slice(0,24);
    return {...material,id:`${material.id.slice(0,39)}-${suffix}`};
  }
  private sameSource(first:ObservedMaterial,second:ObservedMaterial):boolean {
    return first.value===second.value&&JSON.stringify(first.observation)===JSON.stringify(second.observation)
      &&JSON.stringify(first.selection)===JSON.stringify(second.selection);
  }
  assertSave(material: ObservedMaterial): void {
    const existing = this.materials.find(m => m.id === material.id && m.observation.runId === material.observation.runId);
    if (existing && !this.sameSource(existing,material)) throw new Error('材料标识已绑定原文，请使用新的标识');
    const current=this.materials.filter(m=>m.observation.runId===material.observation.runId);
    if (!existing && current.length >= 12) throw new Error('本任务材料已达到上限，不能丢弃已有来源');
  }
  save(material: ObservedMaterial): void {
    this.assertSave(material);
    const current=this.materials.filter(m=>m.observation.runId===material.observation.runId);
    this.materials = current.some(m=>m.id===material.id) ? current : [...current, structuredClone(material)];
  }
  restore(value: unknown): void {
    if (!value || typeof value !== 'object') throw new Error('原文材料检查点无效');
    const m=value as ObservedMaterial, o=m.observation;
    const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
    const verification=m.verification;
    if(verification&&(!text(verification.goalId,64)||!text(verification.revision,64)
      ||!text(verification.criterion,2000)||!text(verification.description,160)
      ||!Number.isFinite(verification.probability)||verification.probability<0||verification.probability>1
      ||!Number.isFinite(verification.at)
      ||verification.reviewedBy!==undefined&&!['jev','main'].includes(verification.reviewedBy)))throw new Error('原文核验证书无效');
    if(m.source!=='observed'||!text(m.id,64)||!text(m.purpose,500)||!text(m.value,MATERIAL_VALUE_MAX)
      ||!o||!text(o.id,200)||!text(o.runId,200)||!text(o.revision,64)
      ||!Number.isSafeInteger(o.tabId)||o.tabId<=0||typeof o.truncated!=='boolean'||!Number.isFinite(o.at))throw new Error('原文材料检查点无效');
    const selection=m.selection;
    if(!selection)throw new Error('原文选取范围无效');
    if(selection.kind==='text') {
      if(o.truncated||!Array.isArray(selection.spans)||!selection.spans.length||selection.spans.length>128
        ||!selection.spans.every((span,i)=>Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)
          &&span.start>=0&&span.end>span.start&&(i===0||span.start>=selection.spans[i-1]!.end)))throw new Error('原文选取范围无效');
    } else if(selection.kind!=='fragments'||!Array.isArray(selection.ids)||!selection.ids.length||selection.ids.length>3000
      ||new Set(selection.ids).size!==selection.ids.length||!selection.ids.every(id=>text(id,100)))throw new Error('原文选取范围无效');
    this.save(m);
  }
}

/** Empty text is a real read; non-form elements must not prefer a stray value property. */
export function elementText(data:Record<string,unknown>):string|undefined {
  const properties=data.properties&&typeof data.properties==='object'?data.properties as Record<string,unknown>:{};
  const form=typeof data.tagName!=='string'||['input','textarea','select','option'].includes(data.tagName.toLowerCase());
  const values=form?[data.value,properties.value,data.textContent,properties.textContent]:[data.textContent,properties.textContent,data.value,properties.value];
  return values.find((value):value is string=>typeof value==='string');
}

/** Retain original whitespace; the generic display redactor also folds blank lines. */
export function redactObservedText(text:string):{text:string;redacted:boolean} {
  const masked=redactCredentialText(text);
  const redacted=masked.split('[redacted]').length>text.split('[redacted]').length;
  return {text:redacted?masked:text,redacted};
}
