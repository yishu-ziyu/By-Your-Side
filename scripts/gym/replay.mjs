/** Replay saved evidence only; never re-execute browser side effects.
 * node scripts/gym/replay.mjs <episode-directory> [--delay=100]
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
if(!process.argv[2])throw new Error('Usage: node scripts/gym/replay.mjs <episode-directory> [--delay=100]');
const dir=resolve(process.argv[2]);
const delay=Number(process.argv.find(x=>x.startsWith('--delay='))?.slice(8)??0);
if(!Number.isFinite(delay)||delay<0||delay>10000)throw new Error('Invalid replay delay');
const read=async file=>(await readFile(join(dir,file),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const events=[...(await read('trace.jsonl')).filter(e=>['tool_execution_start','tool_execution_end','message_end','goal_check'].includes(e.type)).map(e=>({at:Date.parse(e.time),type:e.type,data:e.data})),...(await read('states.jsonl')).map(e=>({at:e.at,type:'page_state',data:e.state}))].sort((a,b)=>a.at-b.at);
for(const event of events){console.log(JSON.stringify(event));if(delay)await new Promise(r=>setTimeout(r,delay));}
const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));console.log(JSON.stringify({status:result.status,verdict:result.verdict,video:result.video,source:dir}));
