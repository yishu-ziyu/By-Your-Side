/** Broader rule comparator. Developed on v1 examples; evaluated only on fresh v2. */
type Params={action:'display';fontFamily?:'songti'|'original';mode?:'bilingual'|'translated'};

export function localDisplay(request:string,hasTranslation:boolean):Params|null{
 if(!hasTranslation)return null;
 const text=request.replace(/[\s，,。.!！?？；;、]/gu,'');

 if(!text||text.length>160)return null;

 // Explicit non-action and outside-scope requests cannot be partially executed.
 if(/[“”「」『』"']|如果|假如|假设|等我|待会|明天|以后|稍后|不是让|不是叫|只是问|只问|只是询问|不要实际|别执行|不用动|先不动|知道|支持|区别|不同|什么意思|怎么做/.test(text))return null;

 if(/总结|概括|摘要|改短|缩短|重写|重新|重译|字号|放大|缩小|大两|颜色|黑体|楷体|仿宋|保存|发送|复制|下载|标题|这一段|选中|选区|部分|正文不变/.test(text))return null;

 if(/恢复.{0,4}原文|撤.{0,4}翻译|去掉.{0,4}翻译/.test(text))return null;

 if(!/改|换|切|恢复|还原|用|排|显示|展示|看|读|留|收|放|要/.test(text))return null;
 const result:Params={action:'display'};
 const songti=text.includes('宋体');
 const negSongti=/(?:不要|别|不用|不想|不改|不换).{0,5}宋体/.test(text);
 const original=/(?:原来|原本|本来|最初|原始|默认).{0,6}(?:字体|字形)|(?:字体|字形).{0,14}(?:原来|原本|本来|最初|原始|默认)|原字体/.test(text);

 if(songti&&!negSongti)result.fontFamily='songti';

 if(original){if(result.fontFamily)return null;result.fontFamily='original';}

 if(negSongti&&!original)return null;
 const bilingualWord=/双语|对照/.test(text);
 const negBilingual=/(?:不要|别|不用).{0,3}(?:双语|对照)/.test(text);
 const both=/中外文.{0,8}(?:一起|同时|都|并排)|原(?:文|句).{0,12}(?:译文|翻译).{0,8}(?:都|一起|同时|并排)|(?:原文|原句).{0,8}(?:也|一起|并排|放回来)|一边.{0,6}原句一边.{0,8}翻译/.test(text);
 const translated=/(?:只|仅).{0,6}(?:译文|翻译后|翻译结果|翻好的)|译文留下即可|(?:原文|源语言内容).{0,6}(?:收起来|别显示|不显示|隐藏)/.test(text);
 const negTranslated=/(?:别|不要).{0,2}只.{0,5}(?:译文|翻译)/.test(text);

 if((bilingualWord&&!negBilingual)||both)result.mode='bilingual';

 if(translated&&!negTranslated){if(result.mode)return null;result.mode='translated';}

 if(negBilingual&&result.mode!=='translated')return null;

 if(negTranslated&&result.mode!=='bilingual')return null;

 return result.fontFamily||result.mode?result:null;
}
