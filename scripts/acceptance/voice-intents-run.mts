/** Frozen classification contract: real model, no browser or task execution. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {VOICE_INTENT_PROMPT} from '../../agent/src/voice-intent.js';
const out=`/tmp/ego-voice-intents-${Date.now()}`;await mkdir(out,{recursive:true});
const raw=await readFile(new URL('./voice-intents.json',import.meta.url),'utf8');
const selected=process.argv.includes('--case')?process.argv[process.argv.indexOf('--case')+1]:undefined;
const rows=(JSON.parse(raw) as Array<{id:string;state:string;text:string;expected:string[];target?:string}>).filter(r=>!selected||r.id===selected);
const report:any={scope:selected??'all',model:'minimax-cn/MiniMax-M3',datasetSha256:createHash('sha256').update(raw).digest('hex'),promptSha256:createHash('sha256').update(VOICE_INTENT_PROMPT).digest('hex'),results:[],rawReplies:[]};
const session=await BrowserAgentSession.create(new ToolRpc(()=>{throw Error('Classifier must not use tools');}),{emit:()=>{},setStatus:()=>{}},{modelPattern:report.model});
if(session.runtime){
 const runtime=session.runtime,original=runtime.completeSimple.bind(runtime);
 runtime.completeSimple=async(...args:Parameters<typeof original>)=>{
  const reply=await original(...args);
  report.rawReplies.push({input:args[1].messages.at(-1)?.content,stopReason:reply.stopReason,text:reply.content.filter(p=>p.type==='text').map(p=>p.text).join('')});
  return reply;
 };
}
const cases=rows.flatMap(row=>[1,2,3].map(repeat=>({row,repeat})));let index=0;
try{
 if(!session.available)throw Error('Model unavailable');
 await Promise.all(Array.from({length:1},async()=>{
  while(index<cases.length){const {row,repeat}=cases[index++]!;const start=Date.now();
   try{const result=await session.classifyVoiceInput(row.text,row.state);
    const ok=JSON.stringify(result.steps.map(s=>s.action))===JSON.stringify(row.expected)&&(!row.target||result.steps[0]?.target===row.target);
    report.results.push({id:row.id,repeat,ok,elapsedMs:Date.now()-start,result});
    if(!ok)console.log(JSON.stringify({id:row.id,repeat,expected:row.expected,result}));
   }catch(error){report.results.push({id:row.id,repeat,ok:false,error:String(error),elapsedMs:Date.now()-start});}
   if(report.results.length%12===0){await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));console.log(`classified ${report.results.length}/${cases.length}`);}
  }
 }));
}catch(error){report.error=String(error);}
finally{
 session.dispose();report.ok=report.results.length===cases.length&&report.results.every((r:any)=>r.ok);
 await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify({out,ok:report.ok,passed:report.results.filter((r:any)=>r.ok).length,total:cases.length,error:report.error}));if(!report.ok)process.exitCode=1;
}
