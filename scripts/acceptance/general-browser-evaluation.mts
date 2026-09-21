/** Frozen implementation / fresh-task ledger. No browser actions, model calls or hidden task generation. */
import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
export const CATEGORIES=['navigation','forms','filters','multi-page','dynamic-controls','correction-recovery'] as const;
export type Category=typeof CATEGORIES[number];
export interface EvaluationTask {id:string;siteId:string;category:Category;url:string;goal:string;oracle:unknown;realSite:boolean;familyId:string}
export interface FrozenImplementation {at:string;sourceHash:string;files:Array<{path:string;sha256:string}>;configuration:Record<string,string|number|boolean>}
const hash=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
export async function freezeImplementation(root:string,configuration:FrozenImplementation['configuration']):Promise<FrozenImplementation>{
 // Explicit allowlist. No home files, credentials or symlink traversal.
 const files:FrozenImplementation['files']=[];
 const visit=async(path:string)=>{for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(path,entry.name);if(entry.isDirectory())await visit(p);else if(entry.isFile())files.push({path:relative(root,p),sha256:hash(await readFile(p))});}};
 for(const dir of ['agent/src','extension/src','extension/dist','shared','scripts/acceptance'])await visit(join(root,dir));
 for(const path of ['package.json','package-lock.json','extension/manifest.json'])files.push({path,sha256:hash(await readFile(join(root,path)))});
 if(!files.length)throw Error('No implementation to freeze');
 return {at:new Date().toISOString(),sourceHash:hash(JSON.stringify({files,configuration})),files,configuration};
}
interface Exposure {bundleHash:string;sourceHash:string;taskIds:string[];familyIds:string[];openedAt:string;attempts:Array<{taskId:string;status:'PASS'|'FAIL'|'BLOCKED';durationMs:number;reason?:string}>}
export interface ExposureLedger {version:1;exposures:Exposure[]}
async function ledger(path:string):Promise<ExposureLedger>{
 try{const v=JSON.parse(await readFile(path,'utf8'));if(v.version!==1||!Array.isArray(v.exposures))throw Error('Invalid exposure ledger');return v;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,exposures:[]};throw e;}
}
async function updateLedger(path:string,update:(value:ExposureLedger)=>void):Promise<void>{
 await mkdir(dirname(path),{recursive:true});
 const lock=await open(path+'.lock','wx',0o600);
 const temporary=path+'.pending';
 try{const value=await ledger(path);update(value);const file=await open(temporary,'w',0o600);try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}await rename(temporary,path);}
 finally{await lock.close();await unlink(path+'.lock');}
}
export async function assertFrozen(root:string,frozen:FrozenImplementation):Promise<void>{
 const now=await freezeImplementation(root,frozen.configuration);
 if(now.sourceHash!==frozen.sourceHash)throw Error('Implementation changed after freezing; opened tasks are regression, not fresh holdout');
}
export async function openHoldout(options:{root:string;frozen:FrozenImplementation;bundlePath:string;ledgerPath:string;developmentSites:string[]}):Promise<{bundleHash:string;tasks:EvaluationTask[]}>{
 await assertFrozen(options.root,options.frozen);
 const bytes=await readFile(options.bundlePath),bundleHash=hash(bytes),raw=JSON.parse(bytes.toString());
 if(raw.provenance?.kind!=='external'||typeof raw.provenance?.source!=='string'||!raw.provenance.source.trim())throw Error('Holdout requires an identified independent task source; self-authored/parameter-only variants are development tasks');
 if(!Array.isArray(raw.tasks)||raw.tasks.length<24)throw Error('Holdout requires at least 24 tasks');
 const tasks=raw.tasks as EvaluationTask[];
 if(tasks.some(t=>!t||typeof t.id!=='string'||!t.id||typeof t.familyId!=='string'||!t.familyId||typeof t.siteId!=='string'||!CATEGORIES.includes(t.category)||typeof t.goal!=='string'||!t.goal.trim()||!t.oracle||typeof t.realSite!=='boolean'||typeof t.url!=='string'||!/^https?:\/\//.test(t.url)))throw Error('Malformed task contract');
 if(new Set(tasks.map(t=>t.id)).size!==tasks.length||new Set(tasks.map(t=>t.familyId)).size!==tasks.length)throw Error('Repeated IDs or template families do not increase unfamiliar task count');
 for(const category of CATEGORIES){const group=tasks.filter(t=>t.category===category);if(group.length<4||new Set(group.map(t=>t.siteId)).size<2)throw Error(`Insufficient category breadth: ${category}`);}
 const sites=new Set(tasks.map(t=>t.siteId));
 if(sites.size<6||[...sites].filter(s=>!options.developmentSites.includes(s)).length<3||tasks.filter(t=>t.realSite).length<Math.ceil(tasks.length/2))throw Error('Insufficient unfamiliar websites or real-site tasks');
 await updateLedger(options.ledgerPath,history=>{
 const exposedIds=new Set(history.exposures.flatMap(e=>e.taskIds)),exposedFamilies=new Set(history.exposures.flatMap(e=>e.familyIds));
 if(history.exposures.some(e=>e.bundleHash===bundleHash)||tasks.some(t=>exposedIds.has(t.id)||exposedFamilies.has(t.familyId)))throw Error('Tasks/families have already been exposed; move them to regression and obtain fresh tasks');
 history.exposures.push({bundleHash,sourceHash:options.frozen.sourceHash,taskIds:tasks.map(t=>t.id),familyIds:tasks.map(t=>t.familyId),openedAt:new Date().toISOString(),attempts:[]});
 });
 return {bundleHash,tasks};
}
export async function recordFirstAttempt(path:string,bundleHash:string,attempt:Exposure['attempts'][number],root:string,frozen:FrozenImplementation):Promise<void>{
 await assertFrozen(root,frozen);
 await updateLedger(path,history=>{
 const exposure=history.exposures.find(e=>e.bundleHash===bundleHash);
 if(!exposure||!exposure.taskIds.includes(attempt.taskId)||exposure.sourceHash!==frozen.sourceHash)throw Error('Task was not revealed through this frozen gate');
 if(exposure.attempts.some(a=>a.taskId===attempt.taskId))throw Error('First attempt is immutable; retries are separate evidence, not replacement scores');
 if(!['PASS','FAIL','BLOCKED'].includes(attempt.status)||!Number.isFinite(attempt.durationMs)||attempt.durationMs<0)throw Error('Invalid attempt');
 exposure.attempts.push(attempt);
 });
}
export async function holdoutSummary(path:string,bundleHash:string){
 const history=await ledger(path),e=history.exposures.find(e=>e.bundleHash===bundleHash);if(!e)throw Error('Unknown batch');
 const counts={PASS:0,FAIL:0,BLOCKED:0,NOT_RUN:e.taskIds.length-e.attempts.length};for(const a of e.attempts)counts[a.status]++;
 return {sourceHash:e.sourceHash,total:e.taskIds.length,counts,passed:counts.PASS===e.taskIds.length};
}
