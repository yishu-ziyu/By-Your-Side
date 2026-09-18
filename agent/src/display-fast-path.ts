import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from './config.js';

export const capabilities={
 scope:'The whole existing page translation; cannot style a heading, paragraph, selection or subset separately.',
 changes:['Font: Songti (宋体) or the original website font','Content display: original plus translation, or translation only'],
 excluded:['New translation, rewriting, summarizing or exporting','Font size, color, weight, spacing, other fonts','Original text only; restore/remove translation'],
};
export const questions={
 direct:{type:'noul',instructions:'Does `request` ask the assistant to change the current display now? Polite requests such as can you help me, and clear desired display preferences addressed to the assistant, count as requests. A capability/information question, quoted instruction, future condition or explicit do-not-act does not.',criteria:{true:'An actual present request to change how the page is displayed.',false:'No present request to act; only discussion, question, quotation, future condition or cancellation.'}},
 extra:{type:'noul',instructions:'Does `request` include any requested operation outside `capabilities.changes`, or ask for an unsupported font, original-text-only display, or another task? Merely saying to preserve existing content is not another task. A partial-page scope is evaluated separately.',criteria:{true:'At least one requested change/task is outside the listed supported changes.',false:'Every requested operation is a supported font or translation display setting.'}},
 partial:{type:'noul',instructions:'Does `request` restrict a display change to a heading, paragraph, selection or other subset of the page, or ask different page parts to have different settings? Translation text versus original text is not such a subset: ordinary translation display settings apply to translated text.',criteria:{true:'A subset needs different styling; the whole-page tool cannot honor this scope.',false:'A normal setting for the page translation, or no subset restriction stated.'}},
 font_requested:{type:'noul',instructions:'Does the current request positively specify a desired font change? Include restoring the website font and clear paraphrases. A font mentioned only as a rejected alternative, quotation or discussion is not a positive font request.'},
 mode_requested:{type:'noul',instructions:'Does the current request positively specify which texts to display: original plus translation, or translation only? Include clear paraphrases such as keeping the translation and hiding the original. A bare rejection of one mode without a positive target is not sufficient.'},
 font:{type:'choice',instructions:'If the request specifies a font target, which target does it mean? Select the intended positive target, not an alternative it rejects. Do not guess a named font from a vague aesthetic preference.',criteria:{songti:'Songti/宋体 is specified, including an unambiguous equivalent name.',original:'The font native to the website is requested.',unspecified:'No positive font target, unsupported font, ambiguous reference or vague aesthetic preference.'}},
 mode:{type:'choice',instructions:'If the request specifies a content display target, which target does it mean? Use the final positive request, including corrections and paraphrases.',criteria:{bilingual:'Original and translated text both displayed.',translated:'Only translated text displayed; original hidden.',unspecified:'No positive target, original-only display, unclear reference or merely negated mode.'}},
};
export function composeReduced(answers:Record<string,any>,hasTranslation:boolean){
 const fallback=(reason:string)=>({params:null,reason});
 if(!hasTranslation)return fallback('no_translation');
 for(const name of ['direct','extra','partial']){
  const p=answers[name]?.noul;if(typeof p!=='number'||!Number.isFinite(p)||p<0||p>1)return fallback('invalid_response');
 }
 if(answers.direct.noul<.8)return fallback('direct_uncertain');
 if(answers.extra.noul>.2)return fallback('extra_or_uncertain');
 if(answers.partial.noul>.2)return fallback('partial_or_uncertain');
 const params:{action:'display';fontFamily?:string;mode?:string}={action:'display'};
 for(const [name,field,allowed] of [['font','fontFamily',['songti','original']],['mode','mode',['bilingual','translated']]] as const){
  const answer=answers[name];
  if(!answer||![...allowed,'unspecified'].includes(answer.choice))return fallback('invalid_response');
  if(answer.choice==='unspecified')continue;
  const p=answer.probabilities?.[answer.choice];
  if(typeof p!=='number'||!Number.isFinite(p)||p<.8||p>1)return fallback(`${name}_uncertain`);
  Object.assign(params,{[field]:answer.choice});
 }
 return params.fontFamily||params.mode?{params,reason:'accepted'}:fallback('no_positive_change');
}

export function displayFastPathEnabled():boolean {
  return process.env.SIDEAGENT_DISPLAY_FASTPATH==='1'||(process.env.SIDEAGENT_DISPLAY_FASTPATH!=='0'&&loadConfig().displayFastPath===true);
}
function readKey():string {
  if(process.env.TYPESAFE_API_KEY)return process.env.TYPESAFE_API_KEY;
  try{return readFileSync(join(homedir(),'.sideagent','typesafe.env'),'utf8').split('\n').find(s=>s.startsWith('TYPESAFE_API_KEY='))?.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g,'')??'';}catch{return '';}
}
export async function decideDisplay(request:string,signal:AbortSignal,onPartialScope?:()=>void){
  const key=readKey();if(!key||signal.aborted)return null;
  const started=Date.now();
  try{
    const response=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'jev-1.13.0',state:{request,hasExistingTranslation:true,capabilities},questions}),signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});
    if(!response.ok){console.error('[display-fast-path]',JSON.stringify({reason:`http_${response.status}`,ms:Date.now()-started}));return null;}
    const raw=await response.json();
    if(Date.now()-started>=1000)return null;
    if(typeof raw.answers?.partial?.noul==='number'&&raw.answers.partial.noul>.2)onPartialScope?.();
    const decision=composeReduced(raw.answers??{},true);const result=decision.params;
    console.error('[display-fast-path]',JSON.stringify({reason:decision.reason,ms:Date.now()-started}));
    // Initial rollout excludes original font; its coverage has not passed acceptance.
    return result?.fontFamily==='original'?null:result;
  }catch{console.error('[display-fast-path]',JSON.stringify({reason:signal.aborted?'cancelled':'timeout_or_network',ms:Date.now()-started}));return null;}
}
