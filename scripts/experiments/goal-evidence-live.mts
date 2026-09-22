import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {loadConfig} from '../../agent/src/config.js';
import {reviewTaskGoal} from '../../agent/src/goal-reasoning-review.js';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {GOAL_REVIEW_GATES,GOAL_REVIEW_QUESTIONS,type GoalReviewStage} from '../../agent/src/goal-evidence-judge.js';

const source=await readFile('eval/goal-evidence/cases.json','utf8');

const cases=JSON.parse(source) as Array<{id:string;split:string;stage:GoalReviewStage;expected:boolean;data:unknown}>;

const out=resolve('out/experiments',`goal-evidence-live-${Date.now()}`);

await mkdir(out,{recursive:true});

const runtime=await ModelRuntime.create(),pattern=loadConfig().model!,slash=pattern.indexOf('/'),model=runtime.getModel(pattern.slice(0,slash),pattern.slice(slash+1));

if(!model)throw new Error('Configured primary model unavailable');

const rows=[];

for(const c of cases){const at=Date.now();let row;

try{const result=await reviewTaskGoal({runtime,model,sessionId:'bys-goal-verification-eval',headers:undefined},c.stage,c.data,AbortSignal.timeout(28000));row={id:c.id,split:c.split,stage:c.stage,expected:c.expected,...result,elapsedMs:Date.now()-at,passed:result.matched===c.expected};}catch(e){row={id:c.id,split:c.split,passed:false,error:String(e)};}

 rows.push(row);console.log(JSON.stringify(row));
}

const report={datasetHash:createHash('sha256').update(source).digest('hex'),questions:GOAL_REVIEW_QUESTIONS,gates:GOAL_REVIEW_GATES,rows,passed:rows.every(r=>r.passed)};

await writeFile(resolve(out,'results.json'),JSON.stringify(report,null,2));

console.log(JSON.stringify({out,passed:report.passed}));

if(!report.passed)process.exitCode=1;
