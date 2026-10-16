/** node scripts/gym/report.mjs <run-directory> — never edits raw samples. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const dir=resolve(process.argv[2]??'');
const rows=(await readFile(join(dir,'results.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const tokens=r=>r.usageComplete?r.network.reduce((n,x)=>n+(x.usage.total_tokens??0),0):null;
const sum=(rs,fn)=>rs.reduce((n,r)=>n+fn(r),0);
const mean=(rs,fn)=>rs.length?(sum(rs,fn)/rs.length).toFixed(1):'—';
const summary=[];
for(const task of ['todo','form','search'])for(const group of ['A','B']){
 const rs=rows.filter(r=>r.task===task&&r.group===group);
 summary.push({task,group,n:rs.length,success:rs.filter(r=>r.status==='success').length,failure:rs.filter(r=>r.status==='failure').length,unknown:rs.filter(r=>r.status==='unknown').length,falseSuccess:sum(rs,r=>Number(r.falseSuccess)),falseFailure:sum(rs,r=>Number(r.falseFailure)),claimUnknown:rs.filter(r=>r.claim==='unknown').length,meanAgentSeconds:Number(mean(rs,r=>(r.agentElapsedMs??0)/1000)),meanTotalSeconds:Number(mean(rs,r=>(r.elapsedMs??0)/1000)),meanCommands:Number(mean(rs,r=>r.budget?.used??0)),meanModelCalls:Number(mean(rs,r=>r.network?.length??0)),meanTokens:rs.every(r=>tokens(r)!==null)?Number(mean(rs,tokens)):null});
}
const table=['|任务|组|成功/总数|失败/未知|误报成功|误报失败|自述未知|Agent秒/总秒|命令|模型调用|Token|','|---|---|---|---|---|---|---|---|---|---|---|',...summary.map(r=>`|${r.task}|${r.group}|${r.success}/${r.n}|${r.failure}/${r.unknown}|${r.falseSuccess}|${r.falseFailure}|${r.claimUnknown}|${r.meanAgentSeconds}/${r.meanTotalSeconds}|${r.meanCommands}|${r.meanModelCalls}|${r.meanTokens??'未知'}|`)];
const detailed=['|样本|独立判定|自述|反馈次数|命令|模型调用|Token|录像|','|---|---|---|---|---|---|---|---|',...rows.map(r=>`|${r.id}|${r.status}${r.verdict?.errors?.length?': '+r.verdict.errors.join(','):''}|${r.claim}|${r.corrections.length}|${r.budget?.used??'未知'}|${r.network?.length??'未知'}|${tokens(r)??'未知'}|${r.video?'[录像]('+r.id+'/execution.mp4)':'未生成'}|`)];
const failures=rows.filter(r=>r.status!=='success'||r.claim!=='success').map(r=>`### ${r.id}\n\n- 独立状态：${r.status}；错误类别：${r.verdict?.errors?.join(',')||'无/未知'}。\n- 助手最后回答：${r.answer||'没有采集到'}\n- 实际状态：\n\n\`\`\`json\n${JSON.stringify(r.finalState,null,2)}\n\`\`\`\n\n- 采集异常：${r.error??'无'}。根因需结合 [完整轨迹](${r.id}/trace.jsonl) 与 [状态变化](${r.id}/states.jsonl) 判断，不由类别自动推断。`);
const report=`# BYS-Gym 实验结果\n\n${rows.length} 次真实样本。只按独立状态成功计分，失败和未知保留。自述分类是保守规则，应对照原话人工复核；不确定表述不算错误失败。Token 含缓存输入与后台调用，现金费用未知。Agent秒取最后 agent_end；总秒包含目标核对和静默等待，不含录像编码。\n\n## 逐任务对照\n\n${table.join('\n')}\n\n## 全部样本\n\n${detailed.join('\n')}\n\n## 失败与不确定交付\n\n${failures.join('\n\n')||'本轮无此类样本。'}\n\n## 解释边界\n\n这只是固定本地任务的探索性实验，不证明统计显著性、真实网站泛化或模型学习。B 与 A 共享现有目标核对和动态模型参数策略；B 的续做经侧栏消息进入，属于实验干预。原始数据见 results.jsonl，各轮包括浏览器事件、模型参数/用量、完整轨迹和截图。\n`;
await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2));await writeFile(join(dir,'report.md'),report);console.log(JSON.stringify(summary,null,2));
