import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CATEGORIES,freezeImplementation,openHoldout,recordFirstAttempt,holdoutSummary,assertFrozen} from '../../scripts/acceptance/general-browser-evaluation.mjs';
const roots:string[]=[];afterEach(async()=>{for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'bys-evaluation-unit-'));roots.push(root);
 for(const d of ['agent/src','extension/src','extension/dist','shared','scripts/acceptance']){await mkdir(join(root,d),{recursive:true});await writeFile(join(root,d,'fixture.ts'),'export const test = 1;');}
 for(const p of ['package.json','package-lock.json','extension/manifest.json'])await writeFile(join(root,p),'{}');
 const frozen=await freezeImplementation(root,{taskModel:'test',decisionModel:'test'}),bundlePath=join(root,'unit-not-real-holdout.json'),ledgerPath=join(root,'ledger.json');
 const tasks=CATEGORIES.flatMap((category,c)=>Array.from({length:4},(_,i)=>({id:`unit-${c}-${i}`,familyId:`unit-family-${c}-${i}`,siteId:`site-${(c+i)%6}`,category,url:`https://unit-${(c+i)%6}.invalid`,goal:'Synthetic ledger unit input, not a browser evaluation',oracle:{unit:true},realSite:true})));
 const bundle={provenance:{kind:'external',source:'unit-fixture-not-an-independent-evaluation'},tasks};await writeFile(bundlePath,JSON.stringify(bundle));
 return {root,frozen,bundlePath,ledgerPath,developmentSites:[],bundle};
}
it('requires the implementation to remain frozen before revealing tasks',async()=>{
 const f=await fixture();await writeFile(join(f.root,'shared/fixture.ts'),'changed');await expect(openHoldout(f)).rejects.toThrow('changed');
});
it('reveals a fresh batch once, and NOT_RUN never becomes PASS',async()=>{
 const f=await fixture(),b=await openHoldout(f);expect((await holdoutSummary(f.ledgerPath,b.bundleHash)).counts.NOT_RUN).toBe(24);
 await expect(openHoldout(f)).rejects.toThrow('already been exposed');
});
it('first failure cannot be overwritten by a successful retry',async()=>{
 const f=await fixture(),b=await openHoldout(f),taskId=b.tasks[0]!.id;
 await recordFirstAttempt(f.ledgerPath,b.bundleHash,{taskId,status:'FAIL',durationMs:123,reason:'unit failure'},f.root,f.frozen);
 await expect(recordFirstAttempt(f.ledgerPath,b.bundleHash,{taskId,status:'PASS',durationMs:1},f.root,f.frozen)).rejects.toThrow('immutable');
 const r=await holdoutSummary(f.ledgerPath,b.bundleHash);expect(r.counts).toEqual({PASS:0,FAIL:1,BLOCKED:0,NOT_RUN:23});expect(r.passed).toBe(false);
});
it('renaming task IDs does not make previously exposed families fresh',async()=>{
 const f=await fixture();await openHoldout(f);f.bundle.tasks=f.bundle.tasks.map(t=>({...t,id:'renamed-'+t.id}));await writeFile(f.bundlePath,JSON.stringify(f.bundle));await expect(openHoldout(f)).rejects.toThrow('already been exposed');
});
it('changes to loaded browser assets invalidate the freeze even with unchanged source',async()=>{
 const f=await fixture();await writeFile(join(f.root,'extension/dist/style.css'),'body { display:none }');await expect(assertFrozen(f.root,f.frozen)).rejects.toThrow();
});
it('changes to the evaluator also invalidate the freeze',async()=>{
 const f=await fixture();await writeFile(join(f.root,'scripts/acceptance/fixture.ts'),'relaxed oracle');await expect(assertFrozen(f.root,f.frozen)).rejects.toThrow();
});
it('changed source cannot reuse a frozen batch score',async()=>{
 const f=await fixture();await openHoldout(f);await writeFile(join(f.root,'agent/src/fixture.ts'),'fix');await expect(assertFrozen(f.root,f.frozen)).rejects.toThrow();
});
it.each(['self-authored','same-site','missing-category','same-family'])('rejects invalid claimed breadth: %s',async(mode)=>{
 const f=await fixture();if(mode==='self-authored')f.bundle.provenance.kind='development';if(mode==='same-site')f.bundle.tasks.forEach(t=>t.siteId='same');if(mode==='missing-category')f.bundle.tasks=f.bundle.tasks.slice(0,23);if(mode==='same-family')f.bundle.tasks[1]!.familyId=f.bundle.tasks[0]!.familyId;
 await writeFile(f.bundlePath,JSON.stringify(f.bundle));await expect(openHoldout(f)).rejects.toThrow();
});
