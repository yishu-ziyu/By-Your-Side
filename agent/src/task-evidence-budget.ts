export interface EvidenceBudgetStore {
  getBranch(): readonly {type:string;customType?:string;data?:unknown}[];
  appendCustomEntry(type:string,data:unknown): unknown;
}

/** Uses the existing private session journal; reservations survive handoff and recovery. */
export function reserveEvidenceWork(store:EvidenceBudgetStore | undefined,input:{runId:string;revision:string;resource:'source-probe'|'goal-review';id:string;gap?:string}):void {
  if (!store) throw new Error('任务核验预算无法保存，本次探测未开始');
  const prior=store.getBranch().filter(e=>e.type==='custom'&&e.customType==='sideagent-evidence-budget-v1').map(e=>e.data as typeof input);
  const used=prior.filter(e=>e.runId===input.runId&&e.revision===input.revision&&e.resource===input.resource&&e.gap===input.gap);

  if (used.some(e=>e.id===input.id)) return;
  const limit=input.resource==='source-probe'?4:24;

  if(used.length>=limit)throw new Error(input.resource==='source-probe'
    ?'为同一未取得的来源已进行了4次脚本/网络探测，仍未保存可复用原文。先用 task_goals inspect/read_observation 和 capture_page_material 处理已有观察；不要换工具继续盲目提取。可以用 snapshot/read_element 补足明确的来源缺口。'
    :'本版任务的24次目标核验预算已用完，请保留已取得的材料，说明具体未完成项。');
  store.appendCustomEntry('sideagent-evidence-budget-v1',{...input,at:Date.now()});
}
