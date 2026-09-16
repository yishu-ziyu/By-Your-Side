/** Real voice-intent model with transcript input; no microphone or acoustic claims. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {BrowserAgentSession} from '../../agent/src/session.js';
import {ToolRpc} from '../../agent/src/rpc.js';
import {loadConfig} from '../../agent/src/config.js';
const out=resolve('docs/evals/20260916-page-translation/voice-results.json');
const session=await BrowserAgentSession.create(new ToolRpc(()=>{throw Error('No browser operations in classification check');}),{emit:()=>{},setStatus:()=>{}},{modelPattern:loadConfig().model});
const results:any[]=[];
try{
 for(const c of [
  {text:'帮我翻译这个页面。',state:'idle',goal:null,action:'start'},
  {text:'我不要双语，只要译文。',state:'running',goal:'帮我翻译这个页面。',action:'steer'},
  {text:'把这个页面翻译成中文，只要译文，不要双语。',state:'idle',goal:null,action:'start'},
  {text:'恢复双语，译文字号改成22。',state:'idle',goal:'帮我翻译这个页面。',action:'start-or-steer'},
 ]){
  const begin=Date.now();const result=await session.prepareVoiceTurn({text:c.text,state:c.state,task:{goal:c.goal}},{protocol:'plan'});
  if(c.action==='start-or-steer'){assert.equal(result.plan.steps.length,1);assert(['start','steer'].includes(result.plan.steps[0]!.action));}else assert.deepEqual(result.plan.steps.map(s=>s.action),[c.action]);assert.equal(result.plan.steps.map(s=>s.text).join(''),c.text);
  results.push({...c,plan:result.plan,elapsedMs:Date.now()-begin});console.log(JSON.stringify(results.at(-1)));
 }
}finally{
 session.dispose();await mkdir(resolve(out,'..'),{recursive:true});await writeFile(out,JSON.stringify({passed:results.length===4,model:session.modelName(),scope:'real classification with transcript text; microphone and end-to-end voice dispatch not run',results},null,2));
}
