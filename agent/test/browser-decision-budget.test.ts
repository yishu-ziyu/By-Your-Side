import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {reserveBrowserDecision} from '../src/browser-decision-budget.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'bys-decision-budget-'));roots.push(root);return {root,file:join(root,'session.jsonl')};}
it('a task shares its durable limit across repeated tool calls and reconstructed callers',()=>{
 const f=fixture();for(let i=0;i<16;i++)reserveBrowserDecision(f.file,'run1');
 expect(()=>reserveBrowserDecision(f.file,'run1')).toThrow('预算已用完');expect(()=>reserveBrowserDecision(f.file,'run2')).not.toThrow();
});
it('refuses model requests without a persistent run identity',()=>{expect(()=>reserveBrowserDecision(undefined,'run')).toThrow();expect(()=>reserveBrowserDecision('/tmp/unused',null)).toThrow();});
it('does not reset corrupt records or an occupied budget lock',()=>{
 const f=fixture();reserveBrowserDecision(f.file,'run1');const name=readdirSync(join(f.root,'decision-budgets')).find(n=>n.endsWith('.reservations'))!,path=join(f.root,'decision-budgets',name);
 writeFileSync(path,'broken');expect(()=>reserveBrowserDecision(f.file,'run1')).toThrow('损坏');
 writeFileSync(path+'.lock','');expect(()=>reserveBrowserDecision(f.file,'run1')).toThrow('占用');
});
