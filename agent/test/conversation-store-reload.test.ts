import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const race=vi.hoisted(()=>({afterWrite:null as (()=>void)|null}));
vi.mock('node:fs',async original=>{
 const fs=await original<typeof import('node:fs')>();
 return {...fs,writeFileSync:(...args:Parameters<typeof fs.writeFileSync>)=>{fs.writeFileSync(...args);const cb=race.afterWrite;race.afterWrite=null;cb?.();}};
});
import {ConversationStore} from '../src/conversation-store.js';
const dirs:string[]=[];
afterEach(()=>{race.afterWrite=null;for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it('keeps staging files separate when a retiring and new host overlap during reload',()=>{
 const dir=mkdtempSync(join(tmpdir(),'conversation-reload-'));dirs.push(dir);
 const first=new ConversationStore(dir),second=new ConversationStore(dir);
 const summary={id:'default',title:'会话',createdAt:1,updatedAt:1,state:'idle' as const,mode:'act' as const};
 // A second process writes and renames after the first write, before its rename.
 race.afterWrite=()=>second.save([{...summary,updatedAt:2}]);
 expect(()=>first.save([summary])).not.toThrow();
 expect(JSON.parse(readFileSync(join(dir,'index.json'),'utf8'))).toHaveLength(1);
 expect(readdirSync(dir).filter(name=>name.endsWith('.tmp'))).toEqual([]);
});
