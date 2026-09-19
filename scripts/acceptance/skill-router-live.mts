/** Live, closed-set Jev routing fixtures. No browser access; no primary model. */
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {compileSkill} from '../../agent/src/skill-compile.js';
import {routeSkill, type SkillRoute} from '../../agent/src/skill-router.js';
import {judgeSkill} from '../../agent/src/skill-judge.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';

const out=resolve('out/acceptance',`skill-router-live-${Date.now()}`);await mkdir(out,{recursive:true});
const skill=compileSkill({id:'search-client',demoId:'fixture',hostname:'example.com',intent:'按客户名和地区搜索客户',requestTemplate:'搜索「{{客户名}}」，地区「{{地区}}」',
  steps:[{at:0,kind:'type',anchor:{tag:'input',name:'客户名',inputType:'search'},value:'张三'},
    {at:1,kind:'type',anchor:{tag:'input',name:'地区',inputType:'text'},value:'北京'},
    {at:2,kind:'click',anchor:{tag:'button',name:'搜索'}}]});
type Fixture={text:string;expected:'match'|'not-match'|'ambiguous'|'needs_input';host?:string;duplicate?:boolean;stale?:boolean};
const calibration:Fixture[]=[
  ...['张三','李四','王五','Alice','Bob'].map(name=>({text:`搜索「${name}」，地区「北京」`,expected:'match' as const})),
  ...['查找客户「李四」，地区是「深圳」','帮忙查询「王五」这位客户，地区「杭州」','客户名=陈晨，地区=上海，请搜索','在「广州」查询名为「王林」的客户','帮我找一下客户「Alice」，地区「Beijing」'].map(text=>({text,expected:'match' as const})),
  ...['不要搜索「李四」，地区「深圳」','明天搜索「李四」，地区「深圳」','如果需要，再搜索「李四」，地区「深圳」','解释搜索功能','搜索「李四」，地区「深圳」，然后导出所有客户',
    '搜索「李四」，地区「深圳」，删除结果','搜索「李四」，地区「深圳」，只显示未联系的客户','搜索「李四」，地区「深圳」，然后发送邮件','找一下有关客户管理的文章','把客户「李四」的地区改成「深圳」',
    '支付「李四」在「深圳」的订单','搜索客户「李四」和「王五」，都在「深圳」','搜索「李四」，地区「深圳」，并保存搜索结果','取消当前任务','帮我看看如何查询「李四」在「深圳」的资料'].map(text=>({text,expected:'not-match' as const})),
  {text:'查找客户「李四」',expected:'needs_input'},
  {text:'搜索「李四」，地区「深圳」',expected:'not-match',host:'other.example'},
  {text:'搜索「李四」，地区「深圳」',expected:'ambiguous',duplicate:true},
  {text:'搜索「李四」，地区「深圳」',expected:'not-match',stale:true},
  {text:'查找客户「李四」，地区是「深圳」，新建另一位客户「王五」',expected:'not-match'},
];
const holdout:Fixture[]=[
  ...[
    '请帮忙检索客户「周宁」，所在地区「苏州」',
    '地区选「武汉」，客户查「赵明」',
    '帮我按「成都」这个地区找「林溪」',
    '查询条件：客户名=高原，地区=南京',
    '现在帮我搜索姓名「Evan」且地区「Boston」的客户',
    '查一下地区「西安」的客户「许南」',
    '找客户「陈夏」，所在地填写「宁波」',
    '按客户名「顾舟」和地区「天津」查询',
  ].map(text=>({text,expected:'match' as const})),
  ...[
    '稍后提醒我去搜索「周宁」，地区「苏州」',
    '别执行，我只是在举例：搜索「周宁」，地区「苏州」',
    '请解释“搜索「周宁」，地区「苏州」”这句话',
    '当我确认后，再查客户「周宁」，地区「苏州」',
    '查客户「周宁」，地区「苏州」，仅保留本月新增的记录',
    '把「周宁」从「苏州」改到「南京」',
    '给「苏州」的「周宁」发一条消息',
    '查询「周宁」在「苏州」的信息，再导出为CSV',
    '搜索「周宁」或「赵明」，地区「苏州」',
    '搜索名字不是「周宁」的客户，地区「苏州」',
    '搜索「周宁」，地区不含「苏州」',
    '我刚才搜索「周宁」，地区「苏州」，现在不需要继续',
  ].map(text=>({text,expected:'not-match' as const})),
  {text:'请查一下客户「周宁」',expected:'needs_input'},
  {text:'按地区「苏州」查询客户',expected:'needs_input'},
];
const fixtures=process.argv.includes('--holdout')?holdout:calibration;
const records:any[]=[];
const report:any={passed:false,credentialAvailable:!!readTypeSafeKey(),fixtures:records,set:process.argv.includes('--holdout')?'holdout':'calibration',scope:'Real Jev, production router, no browser actions',error:null};
try{
  if(!report.credentialAvailable)throw new Error('TypeSafe credential unavailable; live routing is not verified.');
  for(const [index,f] of fixtures.entries()){
    let calls=0,serviceError:string|undefined,judgment:unknown;
    const started=Date.now();
    const result:SkillRoute=await routeSkill({userText:f.text,hostname:f.host??'example.com',skills:f.duplicate?[skill,{...skill,id:'other-recipe'}]:[skill],
      ...(f.stale?{runs:{[skill.id]:Array.from({length:3},()=>({at:1,ok:false,steps:1,elapsedMs:1,failedStep:1}))}}:{})},
      {judge:async(input,signal)=>{calls++;try{const value=await judgeSkill(input,signal);judgment=value;return value;}catch(error){serviceError=error instanceof Error?error.message:String(error);throw error;}}});
    const passed=f.expected==='not-match'?result.status!=='match':result.status===f.expected;
    const record={index,...f,actual:result,elapsedMs:Date.now()-started,calls,serviceError,judgment,passed};records.push(record);
    console.log(JSON.stringify({index,expected:f.expected,actual:result.status,elapsedMs:record.elapsedMs,calls,passed}));
  }
  const matches=records.filter(r=>r.actual.status==='match');
  report.summary={count:records.length,passed:records.filter(r=>r.passed).length,liveCalls:records.reduce((n,r)=>n+r.calls,0),
    incorrectAutomaticMatches:matches.filter(r=>r.expected!=='match').length,matched:matches.length,
    positiveMatched:records.filter(r=>r.expected==='match'&&r.actual.status==='match').length,
    positiveTotal:records.filter(r=>r.expected==='match').length,serviceErrors:records.filter(r=>r.serviceError).length};
  report.passed=records.length===fixtures.length&&records.every(r=>r.passed);
  if(!report.passed)process.exitCode=1;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(`Live router report: ${out}`);}
