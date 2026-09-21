/** Independent read-only outcome checks. Never accepts the acting model's 'done' as proof. */
export type BrowserCheck={kind:'page';property:'url'|'title'|'text'|'value'|'checked'|'visible'|'count'|'selectedText';selector?:string;equals?:string|boolean|number;contains?:string;reason:string};
export type ServerCheck={kind:'server';path:string;jsonPath:string[];equals:string|number|boolean|null;reason:string};
export interface BrowserOracle {version:1;checks:Array<BrowserCheck|ServerCheck>;humanReview?:boolean}
export interface OracleResult {passed:boolean;checks:Array<{passed:boolean;reason:string;observed?:unknown;error?:string}>;humanReview:boolean}
export function validOracle(value:unknown):value is BrowserOracle{
 if(!value||typeof value!=='object')return false;
 const o=value as BrowserOracle;
 if(o.version!==1||!Array.isArray(o.checks)||o.checks.length<1||o.checks.length>40||(o.humanReview!==undefined&&typeof o.humanReview!=='boolean'))return false;
 return o.checks.every(c=>{
  if(!c||typeof c.reason!=='string'||!c.reason.trim())return false;
  if(c.kind==='server')return typeof c.path==='string'&&c.path.startsWith('/')&&!c.path.startsWith('//')&&Array.isArray(c.jsonPath)&&c.jsonPath.length<=12&&c.jsonPath.every(p=>typeof p==='string'&&!['__proto__','constructor','prototype'].includes(p))&&(c.equals===null||typeof c.equals==='boolean'||typeof c.equals==='string'&&c.equals.length<=8000||typeof c.equals==='number'&&Number.isFinite(c.equals));
  if(c.kind!=='page'||!['url','title','text','value','checked','visible','count','selectedText'].includes(c.property))return false;
  if(!['url','title'].includes(c.property)&&(typeof c.selector!=='string'||!c.selector.trim()||c.selector.length>1000))return false;
  if(c.contains!==undefined)return ['url','title','text','value','selectedText'].includes(c.property)&&typeof c.contains==='string'&&c.contains.length>0&&c.contains.length<=8000&&c.equals===undefined;
  if(['checked','visible'].includes(c.property))return typeof c.equals==='boolean';
  if(c.property==='count')return Number.isSafeInteger(c.equals)&&Number(c.equals)>=0;
  return typeof c.equals==='string'&&c.equals.length<=8000;
 });
}
/** Serialized into Chrome's isolated world; has no mutation or model dependency. */
export function inspectPageChecks(checks:BrowserCheck[]):OracleResult['checks']{
 return checks.map(c=>{
  try{
   let observed:unknown;
   if(c.property==='url')observed=location.href;
   else if(c.property==='title')observed=document.title;
   else{
    const elements=document.querySelectorAll(c.selector!);
    if(c.property==='count')observed=elements.length;
    else{
     if(elements.length!==1)throw Error(`Expected one element, found ${elements.length}`);
     const e=elements[0] as HTMLElement&{value?:string;checked?:boolean;selectedOptions?:HTMLCollectionOf<HTMLOptionElement>};
     if(c.property==='text')observed=e.innerText??e.textContent??'';
     if(c.property==='value'){if(!('value' in e))throw Error('Element has no value');observed=e.value;}
     if(c.property==='checked'){if(typeof e.checked!=='boolean')throw Error('Element has no checked state');observed=e.checked;}
     if(c.property==='visible')observed=e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
     if(c.property==='selectedText'){if(!e.selectedOptions)throw Error('Element is not a native select');observed=Array.from(e.selectedOptions).map(o=>o.label).join(', ');}
    }
   }
   const passed=c.contains!==undefined?typeof observed==='string'&&observed.includes(c.contains):observed===c.equals;
   return {passed,reason:c.reason,observed:typeof observed==='string'?observed.slice(0,500):observed};
  }catch(e){return {passed:false,reason:c.reason,error:String(e)};}
 });
}
export async function checkBrowserOutcome(options:{oracle:BrowserOracle;taskUrl:string;tabId:number;swEval:(expression:string,timeout?:number)=>Promise<unknown>}):Promise<OracleResult>{
 const {oracle}=options;if(!validOracle(oracle))throw Error('Invalid independent oracle');
 const pageChecks=oracle.checks.filter((c):c is BrowserCheck=>c.kind==='page');
 const checks:OracleResult['checks']=[];
 if(pageChecks.length){
  const results=await options.swEval(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(options.tabId)}},world:'ISOLATED',func:${inspectPageChecks.toString()},args:[${JSON.stringify(pageChecks)}]}).then(r=>r.find(x=>x.frameId===0)?.result)`,15000);
  if(!Array.isArray(results)||results.length!==pageChecks.length)throw Error('Page oracle did not return its complete result');
  checks.push(...results);
 }
 for(const c of oracle.checks.filter((c):c is ServerCheck=>c.kind==='server')){
  try{
   const origin=new URL(options.taskUrl).origin,url=new URL(c.path,origin);
   if(url.origin!==origin)throw Error('Oracle endpoint must remain on the task origin');
   const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error(`HTTP ${response.status}`);
   if(Number(response.headers.get('content-length')??0)>65536)throw Error('Oracle response too large');
   const reader=response.body?.getReader();if(!reader)throw Error('Empty oracle response');
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw Error('Oracle response too large');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
   let observed:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   for(const key of c.jsonPath){if(!observed||typeof observed!=='object'||!Object.hasOwn(observed,key))throw Error('Missing server-state field');observed=(observed as Record<string,unknown>)[key];}
   checks.push({passed:observed===c.equals,reason:c.reason,observed:typeof observed==='string'?observed.slice(0,500):observed});
  }catch(e){checks.push({passed:false,reason:c.reason,error:String(e)});}
 }
 return {passed:checks.every(c=>c.passed)&&!oracle.humanReview,checks,humanReview:oracle.humanReview===true};
}
