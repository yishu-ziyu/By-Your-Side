import {describe,expect,it} from 'vitest';
import {emptyP0Report,validateP0Report,type P0Manifest,type P0Build} from '../../scripts/eval/lib/p0-contract.js';
const manifest:P0Manifest={version:1,cases:[{id:'one',task:'test',fault:'restart',maxSideEffects:1,preserveRun:true}]};
const build:P0Build={head:'a'.repeat(40),fingerprint:'b'.repeat(64),manifestHash:'c'.repeat(64)};
function passing(){const report=emptyP0Report(manifest,build);report.environment={isolated:true,headless:true,realModelUsed:true,model:'test-fixture'};
  Object.assign(report.cases[0]!,{status:'PASS',startedAt:'2026-09-17T00:00:00Z',endedAt:'2026-09-17T00:01:00Z',beforeRunId:'run',afterRunId:'run',metrics:{expectedOutcome:true,sideEffects:1,duplicateWrites:0,wrongPageWrites:0,recoveryFailures:0,userCorrections:0},evidence:[{kind:'trace',path:'trace.json',sha256:'d'.repeat(64)},{kind:'state',path:'state.json',sha256:'e'.repeat(64)}]});return report;}
describe('P0 live evidence gate',()=>{
  it('cannot pass an untouched template',()=>expect(validateP0Report(emptyP0Report(manifest,build),manifest,build,()=>true).status).toBe('NOT_RUN'));
  it('accepts a complete report only with matching source and evidence',()=>expect(validateP0Report(passing(),manifest,build,()=>true).status).toBe('PASS'));
  it.each(['duplicateWrites','wrongPageWrites','recoveryFailures'] as const)('rejects %s even when the agent writes PASS',field=>{const report=passing();report.cases[0]!.metrics![field]=1;expect(validateP0Report(report,manifest,build,()=>true).status).toBe('FAIL');});
  it('rejects a changed task identity',()=>{const report=passing();report.cases[0]!.afterRunId='new-run';expect(validateP0Report(report,manifest,build,()=>true).status).toBe('FAIL');});
  it('rejects missing, duplicate or skipped cases',()=>{const report=passing();report.cases.push(report.cases[0]!);expect(validateP0Report(report,manifest,build,()=>true).status).toBe('FAIL');report.cases=[];expect(validateP0Report(report,manifest,build,()=>true).status).toBe('FAIL');});
  it('does not reuse results from an older dirty tree',()=>expect(validateP0Report(passing(),manifest,{...build,fingerprint:'f'.repeat(64)},()=>true).status).toBe('FAIL'));
  it('rejects missing or tampered raw evidence',()=>expect(validateP0Report(passing(),manifest,build,()=>false).status).toBe('FAIL'));
  it('does not label mocks as real user simulation',()=>{const report=passing();report.environment.realModelUsed=false;expect(validateP0Report(report,manifest,build,()=>true).status).toBe('FAIL');});
  it('keeps a hardware or budget blocker visible',()=>{const report=emptyP0Report(manifest,build);report.cases[0]!.status='BLOCKED';expect(validateP0Report(report,manifest,build,()=>true).status).toBe('BLOCKED');});
});
