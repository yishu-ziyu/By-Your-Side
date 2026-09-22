/** Frozen comparison baseline, not a production router. Consume the entire request. */
type Params={action:'display';fontFamily?:'songti'|'original';mode?:'bilingual'|'translated'};

const atoms:Array<{pattern:RegExp;change:Partial<Params>}>= [
 {pattern:/^(?:(?:把|将)?(?:已有|现有|当前|这些|这段)?(?:译文|文字|中文|翻译结果)(?:的)?)?(?:字体)?(?:改成|换成|改为|换为|设成|设置为|调成|使用|换用|改用|用)?宋体(?:字体)?/,change:{fontFamily:'songti'}},
 {pattern:/^(?:(?:把|将)?(?:已有|现有|当前|这些)?(?:译文|文字|中文)(?:的)?)?(?:字体)?(?:恢复成?|还原成?|换回|改回|用回)(?:(?:网站|网页|页面)(?:的)?)?(?:原来|原本|原始|默认|最初)(?:的)?字体/,change:{fontFamily:'original'}},
 {pattern:/^(?:恢复|还原|换回|改回)(?:原字体|网站字体)/,change:{fontFamily:'original'}},
 {pattern:/^(?:恢复|切回|改成|换成|显示|使用|开启|切换到|切换成)?(?:双语|中英对照|原文和译文对照|原文与译文对照|原文译文对照)(?:模式|显示)?/,change:{mode:'bilingual'}},
 {pattern:/^(?:让)?(?:原文和译文|原文与译文|原文跟译文)(?:一起显示|同时显示|都显示|一起展示)/,change:{mode:'bilingual'}},
 {pattern:/^(?:只要|只看|只显示|只保留|仅显示|仅保留|仅看)(?:译文|翻译后的文字|翻译后的内容|翻译后的中文)(?:模式)?/,change:{mode:'translated'}},
 {pattern:/^(?:切换到|切换成|改成|换成|使用|用)(?:仅译文|纯译文|译文)(?:模式)/,change:{mode:'translated'}},
];

export function localDisplay(request:string,hasTranslation:boolean):Params|null{
 if(!hasTranslation)return null;
 let text=request.replace(/[\s，,。.!！?？；;、]/gu,'');
 // Remove politeness only at the beginning; unsupported trailing content cannot disappear.
 text=text.replace(/^(?:(?:能不能|可不可以|可以|能否|能)(?:请|帮我)?|请|麻烦|劳驾|帮我|给我)+/,'').replace(/(?:一下|吧|好吗|可以吗|吗)$/,'');
 const result:Params={action:'display'};let count=0;
 const constraints:Array<{fontFamily?:string;mode?:string}>=[];

 while(text&&count++<8){
  text=text.replace(/^(?:然后|并且|同时|再|并|和)/,'');
  // A negative condition constrains the requested result; by itself it cannot trigger execution.
  const negative=text.match(/^(?:我)?(?:不要|别|不用)(双语|宋体|只显示译文|只看译文|仅译文)/);

  if(negative){constraints.push(negative[1]==='宋体'?{fontFamily:'songti'}:{mode:negative[1]==='双语'?'bilingual':'translated'});text=text.slice(negative[0].length);continue;}

  const match=atoms.map(atom=>({atom,match:text.match(atom.pattern)})).find(x=>x.match);

  if(!match)return null;

  for(const [key,value] of Object.entries(match.atom.change)){
   const previous=result[key as keyof Params];

if(previous!==undefined&&previous!==value)return null;
   Object.assign(result,{[key]:value});
  }

  text=text.slice(match.match![0].length);
 }

 if(text||(!result.fontFamily&&!result.mode))return null;

 // Each negated dimension must have an explicit compatible positive target.
 for(const condition of constraints)for(const [key,value] of Object.entries(condition)){
  if(result[key as keyof Params]===undefined||result[key as keyof Params]===value)return null;
 }

 return result;
}
