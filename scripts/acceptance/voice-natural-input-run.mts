/** Natural correction and filler regression; real model, no browser operations. */
import {mkdir,writeFile} from 'node:fs/promises';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {voiceEvidence} from './voice-evidence.mts';
const out=`/tmp/ego-voice-natural-${Date.now()}`;await mkdir(out);
const cases=[
 {state:'running',goal:'打开地图',text:'呃，其实我想打开的是YouTube，然后还需要你帮我检查一下最近的这个邮箱。',actions:['steer']},
 {state:'running',goal:'打开地图',text:'把当前任务改为打开YouTube，然后检查最近的邮件。',actions:['steer']},
 {state:'paused',goal:'打开地图',text:'不看地图了，改为打开YouTube。',actions:['steer']},
 {state:'idle',goal:null,text:'嗯，先打开购物网站，然后帮我查一下今天的天气。',actions:['start']},
 {state:'idle',goal:null,text:'呃，帮我打开一下YouTube。',actions:['start']},
 {state:'running',goal:'查商品',text:'另开一个任务检查邮箱。',actions:['start']},
 {state:'running',goal:'查商品',text:'先暂停任务，再把预算改600，等我说继续。',actions:['pause','steer']},
 {state:'running',goal:'查商品',text:'我想了一下，把另一个会话改成600。',actions:['clarify']},
];
const report:any={evidence:voiceEvidence(),model:'minimax-cn/MiniMax-M3',results:[],ok:false};
const session=await BrowserAgentSession.create(new ToolRpc(()=>{throw Error('No operations allowed');}),{emit:()=>{},setStatus:()=>{}},{modelPattern:report.model});
try{
 for(const c of cases){const start=Date.now();try{const result=await session.classifyVoiceInput(c.text,c.state,[],{goal:c.goal});const ok=JSON.stringify(result.steps.map(s=>s.action))===JSON.stringify(c.actions)&&result.steps.map(s=>s.text).join('')===c.text&&result.steps.every(s=>s.target===null);report.results.push({...c,result,ok,elapsedMs:Date.now()-start});}catch(e){report.results.push({...c,ok:false,error:String(e),elapsedMs:Date.now()-start});}}
 report.ok=report.results.every((r:any)=>r.ok);
}finally{session.dispose();await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,results:report.results}));if(!report.ok)process.exitCode=1;}
