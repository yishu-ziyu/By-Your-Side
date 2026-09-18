/** Experimental only: one state, three independent judgments; no browser execution. */
export const displayQuestions = {
  eligible: {type:'noul', instructions:'Does `request` directly ask ONLY to change the font or bilingual/translation-only display of the existing page translation? Questions about ability, quoted instructions, negations without a positive display change, new translation, restoring original content, font size, other fonts, and any additional task are NOT eligible.', criteria:{true:'A direct request limited to Songti/original font and/or bilingual/translation-only display of existing translations.',false:'Any other request, ambiguity, incomplete instruction, or additional task.'}},
  font: {type:'choice', instructions:'Which font change does `request` explicitly request for existing translations? Do not infer a change from a question, quotation or negated request.',criteria:{keep:'No font change requested',songti:'Change font to Songti/宋体',original:'Restore the website original font, preserving translated content'}},
  mode: {type:'choice', instructions:'Which content display change does `request` explicitly request for existing translations? Do not infer a change from a question, quotation or negated request.',criteria:{keep:'No display mode change requested',bilingual:'Show original and translated text together',translated:'Show only translated text'}},
};
export function composeDisplay(answers:any, hasTranslation:boolean) {
  if(!hasTranslation || !(answers.eligible?.noul>=0.8))return null;
  const font=answers.font,mode=answers.mode;
  if(!['keep','songti','original'].includes(font?.choice)||!['keep','bilingual','translated'].includes(mode?.choice))return null;
  if(!(font.probabilities?.[font.choice]>=0.8)||!(mode.probabilities?.[mode.choice]>=0.8))return null;
  if(font.choice==='keep'&&mode.choice==='keep')return null;
  return {action:'display',...(font.choice==='keep'?{}:{fontFamily:font.choice}),...(mode.choice==='keep'?{}:{mode:mode.choice})};
}
export async function routeDisplay(request:string,hasTranslation:boolean,key:string,signal?:AbortSignal, requestFetch:typeof fetch=fetch) {
  if(!hasTranslation)return {params:null,reason:'no_translation',elapsedMs:0};
  const started=performance.now();
  try {
    const response=await requestFetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'jev-1.13.0',state:{request,hasExistingTranslation:true},questions:displayQuestions}),signal:AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])])});
    if(!response.ok)return {params:null,reason:`http_${response.status}`,elapsedMs:performance.now()-started};
    const raw=await response.json();
    return {params:composeDisplay(raw.answers??{},true),raw,elapsedMs:performance.now()-started};
  }catch{return {params:null,reason:signal?.aborted?'cancelled':'request_failed',elapsedMs:performance.now()-started};}
}
