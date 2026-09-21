import { expect, it } from 'vitest';
import { reserveEvidenceWork } from '../src/task-evidence-budget.js';
it('脚本和网络换工具不重置同一来源缺口的预算；改口或取得材料后另计',()=>{
 const entries:Array<{type:string;customType:string;data:unknown}>=[];
 const store={getBranch:()=>entries,appendCustomEntry:(customType:string,data:unknown)=>entries.push({type:'custom',customType,data})};
 const input={runId:'run',revision:'revision',resource:'source-probe' as const,gap:'comment'};
 for(let i=0;i<4;i++){reserveEvidenceWork(store,{...input,id:`call-${i}`});reserveEvidenceWork(store,{...input,id:`call-${i}`});}
 expect(entries).toHaveLength(4);
 expect(()=>reserveEvidenceWork(store,{...input,id:'another-method'})).toThrow('4次');
 const restored={...store,getBranch:()=>structuredClone(entries)};
 expect(()=>reserveEvidenceWork(restored,{...input,id:'after-recovery'})).toThrow('4次');
 expect(()=>reserveEvidenceWork(restored,{...input,revision:'new-request',id:'new'})).not.toThrow();
 expect(()=>reserveEvidenceWork(restored,{...input,gap:'other-material',id:'other'})).not.toThrow();
});
