/** Real classifier, synthetic conversation; no speech synthesis or browser actions. */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {loadConfig} from '../../agent/src/config.js';
import {classifyVoiceInput} from '../../agent/src/voice-model.js';
const runtime=await ModelRuntime.create(),pattern=loadConfig().model!,slash=pattern.indexOf('/'),model=runtime.getModel(pattern.slice(0,slash),pattern.slice(slash+1));
if(!model)throw new Error('Configured model unavailable');
const cases=[
 {state:'idle',text:'然后把这条评论复制到Flomo的新笔记编辑器。',expected:['steer']},
 {state:'idle',text:'另外查一下明天的天气。',expected:['start']},
 {state:'running',text:'不是置顶那条，改成第一条普通评论。',expected:['steer']},
 {state:'paused',text:'然后把这条评论复制到笔记。',expected:['steer']},
 {state:'interrupted',text:'给原任务补充一下：读完以后把这条评论复制到笔记。',expected:['steer']},
 {state:'interrupted',text:'继续原任务。',expected:['resume']},
 {state:'idle',text:'这个时间索引是什么意思？',expected:['chat']},
];
const out=resolve('out/experiments',`goal-voice-${Date.now()}`);await mkdir(out,{recursive:true});const rows=[];
for(const item of cases){const at=Date.now();let row;try{
 const plan=await classifyVoiceInput({runtime,model,sessionId:'bys-goal-voice-eval',headers:undefined},item.text,item.state,[],{goal:'读取当前视频第一条评论'}, {recentTurns:[{role:'user',text:'读一下这个视频的第一条评论。'},{role:'assistant',text:'第一条置顶评论是导航时间索引：0:00 开场，2:30 第一节。'}],latestResult:null,latestDelivery:null});
 row={...item,actual:plan.steps.map(step=>step.action),elapsedMs:Date.now()-at,passed:JSON.stringify(plan.steps.map(step=>step.action))===JSON.stringify(item.expected)};
}catch(error){row={...item,error:String(error),passed:false};}rows.push(row);console.log(JSON.stringify(row));}
await writeFile(resolve(out,'results.json'),JSON.stringify({model:pattern,rows},null,2));console.log(JSON.stringify({out,passed:rows.every(row=>row.passed)}));if(rows.some(row=>!row.passed))process.exitCode=1;
