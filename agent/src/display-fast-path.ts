import {readTypeSafeKey} from './typesafe-auth.js';
import {loadConfig} from './config.js';
import type {TranslationFont,TranslationMode} from '../../shared/page-translation.js';

export const capabilities={
 scope:'The whole existing page translation; cannot style a heading, paragraph, selection or subset separately.',
 changes:['Font: Songti (宋体) or the original website font','Content display: original plus translation, or translation only'],
 excluded:['New translation, rewriting, summarizing or exporting','Font size, color, weight, spacing, other fonts','Original text only; restore/remove translation'],
};
export const questions={
 direct:{type:'noul',instructions:'Does `request` ask the assistant to change the current display now? Polite requests such as can you help me, and clear desired display preferences addressed to the assistant, count as requests. A capability/information question, quoted instruction, future condition or explicit do-not-act does not.',criteria:{true:'An actual present request to change how the page is displayed.',false:'No present request to act; only discussion, question, quotation, future condition or cancellation.'}},
 extra:{type:'noul',instructions:'Does `request` include any requested operation outside `capabilities.changes`, or ask for an unsupported font, original-text-only display, or another task? Merely saying to preserve existing content is not another task. A partial-page scope is evaluated separately.',criteria:{true:'At least one requested change/task is outside the listed supported changes.',false:'Every requested operation is a supported font or translation display setting.'}},
 partial:{type:'noul',instructions:'Does `request` restrict a display change to a heading, paragraph, selection or other subset of the page, or ask different page parts to have different settings? Translation text versus original text is not such a subset: ordinary translation display settings apply to translated text.',criteria:{true:'A subset needs different styling; the whole-page tool cannot honor this scope.',false:'A normal setting for the page translation, or no subset restriction stated.'}},
 font_requested:{type:'noul',instructions:'Does the current request positively specify a desired font change? In an action request, a direct target such as “宋体” or “use Songti” counts even when phrased briefly. Include restoring the website font and clear paraphrases. A font mentioned only as a rejected alternative, quotation or discussion is not a positive font request.'},
 mode_requested:{type:'noul',instructions:'Does the current request positively specify which texts to display: original plus translation, or translation only? Include clear paraphrases such as keeping the translation and hiding the original. A bare rejection of one mode without a positive target is not sufficient.'},
 font:{type:'choice',instructions:'If the request specifies a font target, which target does it mean? Select the intended positive target, not an alternative it rejects. Do not guess a named font from a vague aesthetic preference.',criteria:{songti:'Songti/宋体 is specified, including an unambiguous equivalent name.',original:'The font native to the website is requested.',unspecified:'No positive font target, unsupported font, ambiguous reference or vague aesthetic preference.'}},
 mode:{type:'choice',instructions:'If the request specifies a content display target, which target does it mean? Use the final positive request, including corrections and paraphrases.',criteria:{bilingual:'Original and translated text both displayed.',translated:'Only translated text displayed; original hidden.',unspecified:'No positive target, original-only display, unclear reference or merely negated mode.'}},
};

/** The only display parameters this stage may hand to the existing tool. */
export interface DisplayParams{action:'display';fontFamily?:TranslationFont;mode?:TranslationMode}
export type DisplayFallbackReason=
  |'no_translation'|'missing_credentials'|'invalid_response'|'direct_uncertain'|'extra_or_uncertain'
  |'partial_or_uncertain'|'font_uncertain'|'mode_uncertain'|'no_positive_change'|'timeout'
  |'late_response'|'network_error'|'unsupported_original_font'|`http_${number}`;
/**
 * A decision is never an execution right: `candidate` only says the parameters are explicit and supported.
 * `fallback` returns to the original model path; `cancelled` must not write and must not start a fallback.
 * `partialScope` carries the observation that the request is scoped to part of the page so the caller can
 * keep the whole-page write constraint even though this route refuses to act.
 */
export type DisplayRoutingResult=
  |{kind:'candidate';params:DisplayParams;reason:'accepted'}
  |{kind:'fallback';reason:DisplayFallbackReason;partialScope?:true}
  |{kind:'cancelled'};

export function composeDisplayDecision(answers:Record<string,any>,hasTranslation:boolean):DisplayRoutingResult{
 const fallback=(reason:DisplayFallbackReason,partialScope=false):DisplayRoutingResult=>({kind:'fallback',reason,...(partialScope?{partialScope:true}:{})});
 if(!hasTranslation)return fallback('no_translation');
 const partialValue=answers?.partial?.noul;
 const partialObserved=typeof partialValue==='number'&&Number.isFinite(partialValue)&&partialValue>0&&partialValue<=1&&partialValue>.2;
 for(const name of ['direct','extra','partial']){
  const p=answers[name]?.noul;if(typeof p!=='number'||!Number.isFinite(p)||p<0||p>1)return fallback('invalid_response',partialObserved);
 }
 if(answers.direct.noul<.8)return fallback('direct_uncertain',partialObserved);
 if(answers.extra.noul>.2)return fallback('extra_or_uncertain',partialObserved);
 if(answers.partial.noul>.2)return fallback('partial_or_uncertain',partialObserved);
 const params:DisplayParams={action:'display'};
 for(const [name,field,allowed] of [['font','fontFamily',['songti','original']],['mode','mode',['bilingual','translated']]] as const){
  const requested=answers[`${name}_requested`]?.noul;
  if(typeof requested!=='number'||!Number.isFinite(requested)||requested<0||requested>1)return fallback('invalid_response');
  if(requested<=.2)continue;
  if(requested<.8)return fallback(`${name}_uncertain` as DisplayFallbackReason);
  const answer=answers[name];
  if(!answer||![...allowed,'unspecified'].includes(answer.choice))return fallback('invalid_response');
  if(answer.choice==='unspecified')continue;
  const p=answer.probabilities?.[answer.choice];
  if(typeof p!=='number'||!Number.isFinite(p)||p<.8||p>1)return fallback(`${name}_uncertain` as DisplayFallbackReason);
  Object.assign(params,{[field]:answer.choice});
 }
 // Restoring the website font still goes through the original model path; coverage has not passed acceptance.
 if(params.fontFamily==='original')return fallback('unsupported_original_font');
 return params.fontFamily||params.mode?{kind:'candidate',params,reason:'accepted'}:fallback('no_positive_change');
}

export function displayFastPathEnabled():boolean {
  return process.env.SIDEAGENT_DISPLAY_FASTPATH==='1'||(process.env.SIDEAGENT_DISPLAY_FASTPATH!=='0'&&loadConfig().displayFastPath===true);
}
/** Runtime (steering) display fast path: off by default and always constrained by the new-task switch. */
export function displaySteerFastPathEnabled():boolean {
  if(!displayFastPathEnabled())return false;
  return process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH==='1'||(process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH!=='0'&&loadConfig().displaySteerFastPath===true);
}
/**
 * One bounded Jev call: fixed model, 1s timeout, no retry. Every uncertainty is a typed fallback;
 * only an explicit supported parameter set becomes a candidate, and a candidate carries no execution right.
 */
export async function decideDisplay(request:string,signal:AbortSignal):Promise<DisplayRoutingResult>{
  if(signal.aborted)return {kind:'cancelled'};
  const key=readTypeSafeKey();
  if(!key)return {kind:'fallback',reason:'missing_credentials'};
  const started=Date.now();
  const log=(reason:string)=>console.error('[display-fast-path]',JSON.stringify({reason,ms:Date.now()-started}));
  try{
    const response=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'jev-1.13.0',state:{request,hasExistingTranslation:true,capabilities},questions}),signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});
    if(signal.aborted)return {kind:'cancelled'};
    if(!response.ok){log(`http_${response.status}`);return {kind:'fallback',reason:`http_${response.status}`};}
    let raw:any;
    try{raw=await response.json();}catch{log('invalid_response');return {kind:'fallback',reason:'invalid_response'};}
    if(signal.aborted)return {kind:'cancelled'};
    if(Date.now()-started>=1000){log('late_response');return {kind:'fallback',reason:'late_response'};}
    const decision=composeDisplayDecision(raw?.answers??{},true);
    if(decision.kind==='cancelled')return decision;
    log(decision.kind==='candidate'?'accepted':decision.reason);
    return decision;
  }catch(error){
    if(signal.aborted)return {kind:'cancelled'};
    const name=error instanceof Error?error.name:'';
    const reason:DisplayFallbackReason=name==='TimeoutError'||/timed? ?out/i.test(error instanceof Error?error.message:'')?'timeout':'network_error';
    log(reason);
    return {kind:'fallback',reason};
  }
}
