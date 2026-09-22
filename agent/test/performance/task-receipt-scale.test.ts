// Run after the functional suite: concurrent test workers distort timing measurements.
// Data volume, 50ms list budget, 20ms event-loop p95 and Vitest's 5s timeout are unchanged.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskReceiptStore } from '../../src/task-dispatcher.js';

const dirs: string[] = [];

afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it('lists 20_000 receipts from memory without scanning the directory',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
  const store=new TaskReceiptStore(dir);

  for(let i=0;i<20_000;i++){
    store.claim(`A:req-${i}`,{fingerprint:'f',pending:false,receipt:{requestId:`req-${i}`,conversationId:'A',source:'text',action:'start',runId:null,text:'x',targetTitle:'A',status:'accepted',message:'ok',updatedAt:i}});
  }

  const listed=store.list('A');
  expect(listed).toHaveLength(5000);
  expect(listed[0]?.requestId).toBe('req-15000');
  const started=performance.now();
  expect(store.list('A')).toHaveLength(5000);
  expect(performance.now()-started).toBeLessThan(50);
  store.sync();
});

it('keeps event-loop delay p95 under 20ms after 20_000 receipts and 200 sessions',async()=>{
  const {monitorEventLoopDelay}=await import('node:perf_hooks');
  const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
  const store=new TaskReceiptStore(dir);

  for(let s=0;s<200;s++){
    const cid=`C${s}`;

    for(let i=0;i<100;i++){
      const n=s*100+i;
      store.claim(`${cid}:req-${n}`,{fingerprint:'f',pending:false,receipt:{requestId:`req-${n}`,conversationId:cid,source:'text',action:'start',runId:null,text:'x',targetTitle:cid,status:'accepted',message:'ok',updatedAt:n}});
    }
  }

  store.list('C0');
  const histogram=monitorEventLoopDelay({resolution:1});
  histogram.enable();

  for(let i=0;i<1000;i++){
    store.list(`C${i%200}`);
    await new Promise((r)=>setImmediate(r));
  }

  histogram.disable();
  const p95=histogram.percentile(95)/1e6;
  expect(p95).toBeLessThanOrEqual(20);
  store.sync();
});
