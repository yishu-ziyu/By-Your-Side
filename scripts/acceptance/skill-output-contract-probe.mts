/**
 * Focused live check of the learning-qualification judgment: does the request ask for more than the saved workflow delivers?
 * Real Jev, no browser, no main model. `--focused` runs the acceptance-shaped wording, where the workflow's own check is part of the judged actions.
 */
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {DELIVERABLE_MIN, deliverableContractInput, judgeDeliverableContract} from '../../agent/src/skill-output-contract.js';
import {readTypeSafeKey} from '../../agent/src/typesafe-auth.js';
import {compileSkill, type Skill} from '../../agent/src/skill-compile.js';
import type {SkillCheck} from '../../shared/skill.js';

const out=resolve('out/acceptance',`skill-output-contract-${Date.now()}`);await mkdir(out,{recursive:true});
const focused=process.argv.includes('--focused');
/** The real query workflow the fixture run performed; actions come from the same helper production uses. */
const workflow:Skill=compileSkill({id:'probe',demoId:'probe',hostname:'example.com',intent:'按客户名和地区搜索客户',
  requestTemplate:'搜索「{{客户名}}」，地区「{{地区}}」',
  steps:[{at:0,kind:'type',anchor:{tag:'input',name:'客户名',inputType:'search'},value:'张三'},
    {at:1,kind:'type',anchor:{tag:'input',name:'地区'},value:'北京'},
    {at:2,kind:'click',anchor:{tag:'button',name:'搜索'}}],
  check:{marker:{tag:'div',name:'查询结果'},text:'核对「查询结果」中的全部本次材料'} as SkillCheck});
type Fixture={text:string;expected:'workflow-only'|'extra'};
const acceptanceShaped = '搜索「{{客户名}}」，地区「{{地区}}」。完成后核对查询结果中的客户名。';
const fixtures:Fixture[]=focused?[
  // 真实验收首条任务的措辞；做法本身就会核对结果，所以它是"整条都能交付"。
  {text:acceptanceShaped,expected:'workflow-only'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」。',expected:'workflow-only'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，并告诉我会员等级。',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，完成后核对查询结果并列出全部结果。',expected:'extra'},
]:[
  {text:acceptanceShaped,expected:'workflow-only'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」',expected:'workflow-only'},
  {text:'查一下客户「{{客户名}}」，地区「{{地区}}」',expected:'workflow-only'},
  {text:'帮我搜索「{{客户名}}」，地区「{{地区}}」',expected:'workflow-only'},
  // A generic completion acknowledgment does not tell the user the search results.
  {text:'搜索客户「{{客户名}}」，地区「{{地区}}」，找到之后告诉我结果',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，并告诉我会员等级',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，列出全部结果',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，把说明翻译成英文',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，然后导出成表格',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，并发送给「王五」',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，只显示未跟进的',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，如果存在就通知我',expected:'extra'},
  {text:'搜索「{{客户名}}」，地区「{{地区}}」，并记下备注「重要」',expected:'extra'},
];
const records:any[]=[];
const report:any={passed:false,credentialAvailable:!!readTypeSafeKey(),threshold:DELIVERABLE_MIN,workflow,fixtures:records,
  scope:focused?'Real Jev, production judgment question, acceptance-shaped wording (the workflow check is part of the judged actions)':'Real Jev, production judgment question, calibration set',error:null};
let liveCalls=0;
try{
  if(!report.credentialAvailable)throw new Error('TypeSafe credential unavailable; the judgment is not verified live.');
  for(const [index,f] of fixtures.entries()){
    const input=deliverableContractInput({...workflow,requestTemplate:f.text});
    const started=Date.now();
    let probability:number|null=null,error:string|null=null;
    try{liveCalls++;probability=await judgeDeliverableContract(input);}
    catch(caught){error=caught instanceof Error?caught.message:String(caught);}
    const verdict=probability===null?'error':probability>=DELIVERABLE_MIN?'workflow-only':'extra';
    const passed=verdict===f.expected;
    records.push({index,...f,input,probability,verdict,error,elapsedMs:Date.now()-started,passed});
    console.log(JSON.stringify({index,expected:f.expected,probability,verdict,elapsedMs:Date.now()-started,passed}));
  }
  report.liveCalls=liveCalls;
  report.summary={count:records.length,passed:records.filter(r=>r.passed).length,
    missedExtraRequirements:records.filter(r=>r.expected==='extra'&&r.verdict==='workflow-only').length,
    blockedNarrowRequests:records.filter(r=>r.expected==='workflow-only'&&r.verdict!=='workflow-only').length};
  report.passed=records.every(r=>r.passed);
  if(!report.passed)process.exitCode=1;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(`Learning-judgment probe report: ${out}`);}
