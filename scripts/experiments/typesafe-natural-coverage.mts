/** Offline natural-language routing comparison. No browser or product side effects. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {localDisplay} from './local-display-router.mts';
import {routeDisplay,displayQuestions} from './typesafe-display-router.mts';

const v2=process.argv.includes('--v2');

const localRouter=v2?(await import('./local-display-router-v2.mts')).localDisplay:localDisplay;

const freeze=JSON.parse(await readFile(`eval/typesafe/display-routing-freeze${v2?'-v2':''}.json`,'utf8'));

for(const [path,hash] of Object.entries(freeze.hashes))assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),hash,'Frozen implementation changed');

const cases=JSON.parse(await readFile(`eval/typesafe/display-natural-holdout${v2?'-v2':''}.json`,'utf8'));

assert(Array.isArray(cases)&&cases.length>0&&cases.length<=48);

assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);

const key=(await readFile('.env.typesafe.local','utf8')).split('\n').find(s=>s.startsWith('TYPESAFE_API_KEY='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');

assert(key);

const out=resolve('out/experiments',`typesafe-natural-${Date.now()}`);

await mkdir(out,{recursive:true});

await writeFile(join(out,'frozen.json'),JSON.stringify({freeze,questions:displayQuestions,cases},null,2));

const signature=(p:any)=>p===null?'fallback':JSON.stringify([p.action,p.fontFamily??null,p.mode??null]);

const rows:any[]=[];

let index=0;

async function worker(){
 while(index<cases.length){
  const c=cases[index++];const started=performance.now();let local:any;

  for(let repeat=0;repeat<100;repeat++)local=localRouter(c.text,c.hasTranslation);
  const localMs=(performance.now()-started)/100;
  const jev=await routeDisplay(c.text,c.hasTranslation,key);
  const row={...c,local,localMs,jev,hybrid:local??jev.params};rows.push(row);
  await writeFile(join(out,`${c.id}.json`),JSON.stringify(row,null,2));
 }
}

await Promise.all([worker(),worker()]);

rows.sort((a,b)=>a.id.localeCompare(b.id));

function stats(selected:any[],method:'local'|'jev'|'hybrid'){
 const value=(r:any)=>method==='jev'?r.jev.params:r[method];
 const positives=selected.filter(r=>r.expected!==null),negatives=selected.filter(r=>r.expected===null);

 return {cases:selected.length,eligible:positives.length,correctDirect:positives.filter(r=>signature(value(r))===signature(r.expected)).length,positiveFallback:positives.filter(r=>value(r)===null).length,wrongParams:positives.filter(r=>value(r)!==null&&signature(value(r))!==signature(r.expected)).length,negatives:negatives.length,falseAccept:negatives.filter(r=>value(r)!==null).length,allExact:selected.filter(r=>signature(value(r))===signature(r.expected)).length};
}

const methods=['local','jev','hybrid'] as const;

const realCalls=rows.filter(r=>r.jev.raw||r.jev.reason!=='no_translation');

const times=realCalls.map(r=>r.jev.elapsedMs).sort((a,b)=>a-b);

const summary={cases:rows.length,methods:Object.fromEntries(methods.map(m=>[m,stats(rows,m)])),categories:Object.fromEntries([...new Set(rows.map(r=>r.category))].map(category=>[category,Object.fromEntries(methods.map(m=>[m,stats(rows.filter(r=>r.category===category),m)]))])),jevWins:rows.filter(r=>r.expected!==null&&signature(r.jev.params)===signature(r.expected)&&signature(r.local)!==signature(r.expected)).map(r=>r.id),localWins:rows.filter(r=>r.expected!==null&&signature(r.local)===signature(r.expected)&&signature(r.jev.params)!==signature(r.expected)).map(r=>r.id),falseAccepts:Object.fromEntries(methods.map(m=>[m,rows.filter(r=>r.expected===null&&(m==='jev'?r.jev.params:r[m])!==null).map(r=>r.id)])),jevRequests:realCalls.length,serviceFailures:rows.filter(r=>['request_failed','cancelled'].includes(r.jev.reason)||r.jev.reason?.startsWith('http_')).map(r=>r.id),latencyMs:{jevP50:times[Math.ceil(times.length*.5)-1],jevP95:times[Math.ceil(times.length*.95)-1],localMean:rows.reduce((s,r)=>s+r.localMs,0)/rows.length},inputTokens:rows.reduce((s,r)=>s+(r.jev.raw?.usage?.input_tokens??0),0),hybridJevRequests:rows.filter(r=>r.local===null&&r.hasTranslation).length,out};

await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));

console.log(JSON.stringify({...summary,categories:undefined},null,2));
