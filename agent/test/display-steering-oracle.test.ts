import {describe, expect, it} from 'vitest';
import {displayAcceptanceExitCode, judgeDisplaySteeringRun, median, summarizeDisplaySteering, type DisplayAcceptanceRun} from '../../scripts/acceptance/display-steering-oracle.mjs';

const good = ():DisplayAcceptanceRun => ({
  name:'pair', enabled:true, runId:'r1', conversationId:'default', tabId:7,
  finalMatch:true, settle:'settled', sameRunId:true, conversationCountBefore:1, conversationCountAfter:1,
  deliveries:[{runId:'r1',conversationId:'default',kind:'finding',text:'段落数：4\n概括：阅读笔记、研究工具、资料对比和下一步行动。'}],
  steeringReceipt:{runId:'r1',action:'steer',status:'applied'},
  displayExecutions:[{id:'call1',params:{mode:'translated'},ok:true,executionFact:'executed',tabId:7,document:'doc',runId:'r1'}],
  reTranslate:0, pageChangedMs:500,totalMs:2000,direct:true,jevCalls:1,
});

describe('display steering acceptance oracle',()=>{
  it('accepts the real fixture outcome, not an arbitrary delivery',()=>expect(judgeDisplaySteeringRun(good()).ok).toBe(true));
  it.each(['段落数：99\n概括：阅读笔记、研究工具、资料对比和下一步行动。','段落数：4','段落数：4\n概括：今天的天气很好。'])('rejects wrong or missing task evidence: %s',answer=>{
    const run=good();run.deliveries[0]!.text=answer;expect(judgeDisplaySteeringRun(run).ok).toBe(false);
  });
  it('rejects a correct-looking answer from a different run',()=>{
    const run=good();run.deliveries[0]!.runId='old';expect(judgeDisplaySteeringRun(run).ok).toBe(false);
  });
  it('judges the latest complete report without confusing a revised report with duplicate fields',()=>{
    const run=good();run.deliveries.push({...run.deliveries[0]!});expect(judgeDisplaySteeringRun(run).ok).toBe(true);
    run.deliveries[1]!.text='段落数：99\n概括：阅读笔记、研究工具、资料对比和下一步行动。';
    expect(judgeDisplaySteeringRun(run).ok).toBe(false);
    run.deliveries[1]!.text='概括：阅读笔记、研究工具、资料对比和下一步行动。';
    expect(judgeDisplaySteeringRun(run).ok).toBe(false);
  });
  it('rejects repeated actual writes but not a rejected attempt or distinct split operations',()=>{
    const run=good(),first=run.displayExecutions[0]!;
    run.displayExecutions.push({...first,id:'call2'});expect(judgeDisplaySteeringRun(run).checks.noRepeatedExecution).toBe(false);
    run.displayExecutions[1]={...first,id:'call2',ok:false,executionFact:'not_executed'};expect(judgeDisplaySteeringRun(run).ok).toBe(true);
    run.displayExecutions[1]={...first,id:'call2',params:{fontFamily:'songti'}};expect(judgeDisplaySteeringRun(run).ok).toBe(true);
    run.displayExecutions[1]={...first};expect(judgeDisplaySteeringRun(run).ok).toBe(true);
  });
  it('does not accept an unknown write or missing receipt',()=>{
    const run=good();run.displayExecutions[0]!.executionFact='unknown';expect(judgeDisplaySteeringRun(run).ok).toBe(false);
    run.displayExecutions=[];expect(judgeDisplaySteeringRun(run).ok).toBe(false);
  });
  it('does not accept a failed steering handoff merely because the page and original answer look correct',()=>{
    const run=good();run.steeringReceipt!.status='failed';expect(judgeDisplaySteeringRun(run).ok).toBe(false);
  });
  it('accepts an actual normal-model fallback after a rejected direct attempt, without labelling it direct',()=>{
    const run=good();run.direct=false;run.steeringReceipt!.status='accepted';
    run.displayExecutions.push({id:'rejected-direct',params:{mode:'translated'},ok:false,executionFact:'not_executed',tabId:7,document:'doc',runId:'r1'});
    expect(judgeDisplaySteeringRun(run).ok).toBe(true);
  });
  it('keeps failures in denominators and pairs instead of silently dropping them',()=>{
    const off={...good(),enabled:false,pageChangedMs:1000};const on=good();on.deliveries[0]!.text='正文共99段，未提供概括';
    const result=summarizeDisplaySteering([off,on],[{pair:0,arms:{off,on}}],[]);
    expect(result.allRunsCorrect).toBe(false);expect(result.on).toMatchObject({runs:1,success:0});
    expect(result.pairedObservations).toEqual([{pair:0,complete:false,deltaMs:null}]);
  });
  it('uses both middle observations for even medians and ignores nulls, not zero',()=>{
    expect(median([2927,-12537,-7119,-18165,11669,-38705,3696,-7375,3427,-19057])).toBe(-7247);
    expect(median([null,0,10])).toBe(5);expect(median([])).toBeNull();
  });
  it('a failing boundaries-only run exits nonzero',()=>{
    const summary={allRunsCorrect:false,boundaryFailures:1,pairs:0};
    expect(displayAcceptanceExitCode({summary,boundariesOnly:true,boundaries:[{failure:'late write'}]})).toBe(1);
    expect(displayAcceptanceExitCode({summary,boundariesOnly:true,boundaries:[]})).toBe(1);
  });
  it('batch spot checks use explicit pairsExpected; the formal default remains 10 pairs',()=>{
    const ok={allRunsCorrect:true,boundaryFailures:0};
    // 分批括查：3 对全对且显式传 3 → 退出 0，供快速回路用。
    expect(displayAcceptanceExitCode({summary:{...ok,pairs:3},pairsExpected:3})).toBe(0);
    // 没传 pairsExpected 时 3 对不算正式通过，仍退出 1。
    expect(displayAcceptanceExitCode({summary:{...ok,pairs:3}})).toBe(1);
    // 分批数量没 satisfaction 足也退出 1（括查 3 对只跑了 2 对）。
    expect(displayAcceptanceExitCode({summary:{...ok,pairs:2},pairsExpected:3})).toBe(1);
    // 任一 run 不正确时无论范围多大都退出 1。
    expect(displayAcceptanceExitCode({summary:{allRunsCorrect:false,boundaryFailures:0,pairs:3},pairsExpected:3})).toBe(1);
  });
});
