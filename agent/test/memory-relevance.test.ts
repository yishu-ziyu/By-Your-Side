import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MEMORY_STORE_FILE, MemoryStore} from '../src/memory-store.js';
import {FileDocument} from './fixtures/file-document.js';

const dirs:string[]=[];

afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

async function store(){const dir=await mkdtemp(join(tmpdir(),'memory-relevance-'));dirs.push(dir);

return new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE));}

it('retrieves a named meeting even when Han text touches an identifier',async()=>{
 const s=await store();const m=await s.create({text:'整理北岸会议205974的会议摘要时，请用三条要点。',scope:{kind:'all'},sourceConversationId:'a'});
 expect(await s.select({text:'整理北岸会议205974这份会议记录：用户找不到旧记录；团队准备改进搜索；成本下周确认。'})).toEqual([m]);
});

it('does not confuse a generic request to organize with a meeting preference',async()=>{
 const s=await store();await s.create({text:'整理会议摘要时，请用三条要点。',scope:{kind:'all'},sourceConversationId:'a'});
 expect(await s.select({text:'请帮我整理出行清单：雨伞、雨衣。'})).toEqual([]);
});
