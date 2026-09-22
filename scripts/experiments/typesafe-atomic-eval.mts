import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {routeAtomic,questions,capabilities} from './typesafe-display-atomic.mts';
import {routeDisplay} from './typesafe-display-router.mts';

const dev=process.argv.includes('--dev');

const reduced=process.argv.includes('--reduced');

const routeNew=reduced?(await import('./typesafe-display-reduced.mts')).routeReduced:routeAtomic;

const file=reduced?'eval/typesafe/display-reduced-holdout.json':dev?'eval/typesafe/display-natural-holdout-v2.json':'eval/typesafe/display-atomic-holdout.json';

const cases=JSON.parse(await readFile(file,'utf8'));

assert(cases.length<=24&&cases.length>0);

const key=(await readFile('.env.typesafe.local','utf8')).split('\n').find(s=>s.startsWith('TYPESAFE_API_KEY='))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');

assert(key);

const out=resolve('out/experiments',`typesafe-atomic-${dev?'dev':'holdout'}-${Date.now()}`);

await mkdir(out,{recursive:true});

const hashes=Object.fromEntries(await Promise.all(['scripts/experiments/typesafe-display-atomic.mts','scripts/experiments/typesafe-display-router.mts',...(reduced?['scripts/experiments/typesafe-display-reduced.mts']:[])].map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));

await writeFile(join(out,'frozen.json'),JSON.stringify({cases,hashes,questions,capabilities,dev,reduced,provenance:'Parent-authored prospective synthetic evaluation; not independently blinded'},null,2));

let index=0;

const rows:any[]=[];

async function worker(){while(index<cases.length){const n=index++,c=cases[n];let old:any,newer:any;

 if(dev){old=JSON.parse(await readFile(`out/experiments/typesafe-natural-1789703735091/${c.id}.json`,'utf8')).jev;newer=await routeNew(c.text,c.hasTranslation,key);}
 else if(n%2){newer=await routeNew(c.text,c.hasTranslation,key);old=await routeDisplay(c.text,c.hasTranslation,key);}
 else{old=await routeDisplay(c.text,c.hasTranslation,key);newer=await routeNew(c.text,c.hasTranslation,key);}

 const row={...c,old,newer};rows.push(row);await writeFile(join(out,`${c.id}.json`),JSON.stringify(row,null,2));}}

await Promise.all([worker(),worker()]);

const sig=(p:any)=>p===null?'fallback':JSON.stringify([p.action,p.fontFamily??null,p.mode??null]);

const summary:any={dev,out,cases:rows.length};

for(const method of ['old','newer']){const positive=rows.filter(r=>r.expected!==null),negative=rows.filter(r=>r.expected===null);const times=rows.filter(r=>r.hasTranslation).map(r=>r[method].elapsedMs).sort((a,b)=>a-b);
 summary[method]={positive:positive.length,correctDirect:positive.filter(r=>sig(r.expected)===sig(r[method].params)).length,wrongParams:positive.filter(r=>r[method].params!==null&&sig(r.expected)!==sig(r[method].params)).map(r=>r.id),fallback:positive.filter(r=>r[method].params===null).map(r=>({id:r.id,reason:r[method].reason})),negative:negative.length,falseAccept:negative.filter(r=>r[method].params!==null).map(r=>r.id),p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],inputTokens:rows.reduce((s,r)=>s+(r[method].raw?.usage?.input_tokens??0),0),serviceFailures:rows.filter(r=>['request_failed','invalid_response','cancelled'].includes(r[method].reason)||r[method].reason?.startsWith('http_')).map(r=>r.id)};
}

summary.acceptance=summary.newer.wrongParams.length===0&&summary.newer.falseAccept.length===0&&summary.newer.serviceFailures.length===0&&summary.newer.correctDirect>summary.old.correctDirect;

await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));

console.log(JSON.stringify(summary,null,2));

if(!summary.acceptance)process.exitCode=1;
