/** Focused live re-check of the clarification fix: only the affected fixtures. Real Jev, no browser, no main model. */
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {compileSkill} from '../../agent/src/skill-compile.js';
import {routeSkill, type SkillRoute} from '../../agent/src/skill-router.js';
import {judgeSkill} from '../../agent/src/skill-judge.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';

const out=resolve('out/acceptance',`skill-router-clarify-${Date.now()}`);

await mkdir(out,{recursive:true});

const skill=compileSkill({id:'search-client',demoId:'fixture',hostname:'example.com',intent:'按客户名和地区搜索客户',requestTemplate:'搜索「{{客户名}}」，地区「{{地区}}」',
  steps:[{at:0,kind:'type',anchor:{tag:'input',name:'客户名',inputType:'search'},value:'张三'},
    {at:1,kind:'type',anchor:{tag:'input',name:'地区',inputType:'text'},value:'北京'},
    {at:2,kind:'click',anchor:{tag:'button',name:'搜索'}}]});

type Fixture={text:string;expected:'match'|'not-match'|'needs_input'};

// Genuine missing-material requests plus the not-match cases most able to flip into a false clarification.
const fixtures:Fixture[]=[
  {text:'查找客户「李四」',expected:'needs_input'},
  {text:'请查一下客户「周宁」',expected:'needs_input'},
  {text:'按地区「苏州」查询客户',expected:'needs_input'},
  {text:'搜索客户「李四」和「王五」，都在「深圳」',expected:'not-match'},
  {text:'搜索「周宁」或「赵明」，地区「苏州」',expected:'not-match'},
  {text:'搜索「周宁」，地区不含「苏州」',expected:'not-match'},
  {text:'把客户「李四」的地区改成「深圳」',expected:'not-match'},
  {text:'给「苏州」的「周宁」发一条消息',expected:'not-match'},
  {text:'支付「李四」在「深圳」的订单',expected:'not-match'},
  {text:'查找客户「李四」，地区是「深圳」，新建另一位客户「王五」',expected:'not-match'},
  {text:'稍后提醒我去搜索「周宁」，地区「苏州」',expected:'not-match'},
  {text:'别执行，我只是在举例：搜索「周宁」，地区「苏州」',expected:'not-match'},
];

const records:any[]=[];

const report:any={passed:false,credentialAvailable:!!readTypeSafeKey(),fixtures:records,scope:'Real Jev, production router, affected group only',error:null};

let liveCalls=0;

try{
  if(!report.credentialAvailable)throw new Error('TypeSafe credential unavailable; live routing is not verified.');

  for(const [index,f] of fixtures.entries()){
    let judgment:unknown;
    const started=Date.now();

    const result:SkillRoute=await routeSkill({userText:f.text,hostname:'example.com',skills:[skill]},
      {judge:async(input,signal)=>{liveCalls++;judgment=await judgeSkill(input,signal);

return judgment as never;}});

    const passed=f.expected==='not-match'?result.status!=='match':result.status===f.expected;
    records.push({index,...f,actual:result,elapsedMs:Date.now()-started,judgment,passed});
    console.log(JSON.stringify({index,expected:f.expected,actual:result.status,elapsedMs:Date.now()-started,passed}));
  }

  report.liveCalls=liveCalls;
  report.summary={count:records.length,passed:records.filter(r=>r.passed).length,
    incorrectAutomaticMatches:records.filter(r=>r.actual.status==='match'&&r.expected!=='match').length};
  report.passed=records.every(r=>r.passed);

  if(!report.passed)process.exitCode=1;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(`Clarification re-check report: ${out}`);}
