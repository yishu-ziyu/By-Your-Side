/** Experimental atomic display routing. This module never executes page actions. */
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
type Answers=Record<string,any>;
export function composeAtomic(answers:Answers,hasTranslation:boolean){
 const fallback=(reason:string)=>({params:null,reason});
 if(!hasTranslation)return fallback('no_translation');
 for(const name of ['direct','extra','partial','font_requested','mode_requested']){
  const value=answers[name]?.noul;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)return fallback('invalid_response');
 }
 if(answers.direct.noul<.8)return fallback('direct_uncertain');
 if(answers.extra.noul>.2)return fallback('extra_or_uncertain');
 if(answers.partial.noul>.2)return fallback('partial_or_uncertain');
 const params:{action:'display';fontFamily?:string;mode?:string}={action:'display'};
 for(const [presence,name,field,allowed] of [['font_requested','font','fontFamily',['songti','original']],['mode_requested','mode','mode',['bilingual','translated']]] as const){
  const probability=answers[presence].noul;
  if(probability<=.2)continue;
  if(probability<.8)return fallback(`${name}_presence_uncertain`);
  const answer=answers[name];
  if(!answer||!(allowed as readonly string[]).includes(answer.choice))return fallback(`${name}_unspecified`);
  const selected=answer.probabilities?.[answer.choice];
  if(typeof selected!=='number'||!Number.isFinite(selected)||selected<.8||selected>1)return fallback(`${name}_uncertain`);
  Object.assign(params,{[field]:answer.choice});
 }
 if(!params.fontFamily&&!params.mode)return fallback('no_positive_change');
 return {params,reason:'accepted'};
}
export async function routeAtomic(request:string,hasTranslation:boolean,key:string,signal?:AbortSignal){
 if(!hasTranslation)return {params:null,reason:'no_translation',elapsedMs:0};
 if(signal?.aborted)return {params:null,reason:'cancelled',elapsedMs:0};
 const started=performance.now();
 try{
  const response=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'jev-1.13.0',state:{request,hasExistingTranslation:true,capabilities},questions}),signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});
  if(!response.ok)return {params:null,reason:`http_${response.status}`,elapsedMs:performance.now()-started};
  const raw=await response.json();return {...composeAtomic(raw.answers??{},true),raw,elapsedMs:performance.now()-started};
 }catch{return {params:null,reason:signal?.aborted?'cancelled':'request_failed',elapsedMs:performance.now()-started};}
}
