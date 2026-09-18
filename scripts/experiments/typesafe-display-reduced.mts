/** Bounded repair: retain independent risk checks, consume each selected parameter once. */
import {routeAtomic} from './typesafe-display-atomic.mts';
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
export async function routeReduced(request:string,hasTranslation:boolean,key:string,signal?:AbortSignal){
 const result=await routeAtomic(request,hasTranslation,key,signal);
 return result.raw?{...result,...composeReduced(result.raw.answers??{},hasTranslation)}:result;
}
