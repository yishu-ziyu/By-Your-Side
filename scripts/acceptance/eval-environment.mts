/** F1 正常页被排除；F2 助手自称断网被排除；F3 真断连/429/验证码仍算模型失败；F4 报表分母错误。 */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { siteBlock } from '../../eval/harness/environment.mjs';
import { runJob } from '../../eval/harness/job.mjs';
import { judgeOne } from '../../eval/harness/judge.mjs';

const reportOnly=process.argv.includes('--report-only');

const out=join(process.cwd(),'out/acceptance/eval-environment',new Date().toISOString().replace(/[:.]/g,'-'));

await mkdir(out,{recursive:true});

assert.equal(siteBlock({url:'https://news.ycombinator.com/front?day=2024-01-01',title:'',text:'Sorry\n'})?.kind,'rate_limit');

assert.equal((await judgeOne({id:'BYS-040'}, {id:'BYS-040',status:'completed',final_page:{url:'https://books.toscrape.com/catalogue/category/books/travel_2/',title:'Travel'},site_observations:[{url:'https://books.toscrape.com/catalogue/category/books/travel_2/',status:429}],errors:[]})).verdict,'pass','later site block cannot erase proved task success');

assert.equal(siteBlock({url:'https://example.com',title:'',text:'Sorry\n'}),null);

assert.equal(siteBlock({url:'https://example.com',title:'Network troubleshooting',text:'ERR_CONNECTION_CLOSED can occur. Verify you are human is a common phrase.'}),null);

assert.equal((await judgeOne({id:'BYS-040'}, {id:'BYS-040',status:'completed',final_answer_verbatim:'网站连不上',final_page:{url:'https://books.toscrape.com',title:'Books'},final_page_text:'Books to Scrape'})).method,'deterministic');

const server=createServer((req,res)=>{
 if(req.url==='/reset'){res.destroy();

return;}

 if(req.url==='/limited'){res.writeHead(429,{'content-type':'text/html'});res.end('<h1>Too Many Requests</h1>');

return;}

 res.writeHead(403,{'content-type':'text/html'});res.end('<title>Verify you are human</title><h1>Verify you are human</h1><div class="cf-turnstile"></div>');
});

await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));

// SAFETY: 已 await TCP listen(0,127.0.0.1)，返回绑定端口的 AddressInfo。
const address=server.address() as AddressInfo;

const origin=`http://127.0.0.1:${address.port}`;

process.env.BYS_KEY_ZAI_CODING_CN='fixture-no-model-call';

const tasks=JSON.parse(await readFile('eval/runs/tiers12-20261002/run.json','utf8')).tasks;

const all=(await readFile('eval/tasks/tasks.jsonl','utf8')).trim().split('\n').map(JSON.parse);

try{
 for(const [i,path] of (reportOnly?[]:['/reset','/limited','/captcha']).entries()){
  const task={...all.find((t:any)=>t.id===tasks[i]),site_url:origin+path,prompt:'读取这个页面'};
  const rec=await runJob({task,model:'zai-coding-cn/glm-5.3-flash',outDir:join(out,'fixture'),capMs:10000});
  const verdict=await judgeOne(task,rec);
  assert.equal(verdict.verdict,'environment',path);
  assert.ok(verdict.environment.evidence.length,path);
  assert.equal(rec.n_tool_calls??0,0,'blocked initial page must not consume model calls');
  assert.ok(rec.screenshots.length,'actual browser evidence');
  console.log('PASS browser',path);
 }

 const model='probe/model',slug='probe_model';
 await mkdir(join(out,slug),{recursive:true});await mkdir(join(out,'judge',slug),{recursive:true});

 for(const [i,verdict] of ['pass','fail','environment'].entries()){
  const id=tasks[i];
  await writeFile(join(out,slug,id+'.json'),JSON.stringify({id,model,status:'completed',seconds_total:1,main_model:model,fast_model:model,errors:[]}));
  await writeFile(join(out,slug,id+'.trace.jsonl'),JSON.stringify({type:'message_end',data:{message:{role:'assistant',provider:'probe',model:'model',usage:{input:i===2?100:i===0?10:20,output:i===2?0:20}}}})+'\n');
  await writeFile(join(out,'judge',slug,id+'.json'),JSON.stringify({verdict,pass:verdict==='pass',environment:verdict==='environment'?{kind:'rate_limit',evidence:[{status:429}]}:null}));
 }

 await writeFile(join(out,'run.json'),JSON.stringify({runId:'environment-oracle',models:[model],tasks:tasks.slice(0,3)}));
 execFileSync('python3',['eval/harness/analyze.py',out]);
 const report=JSON.parse(await readFile(join(out,'report.json'),'utf8'));
 assert.equal(report.all_valid[model].n_judged,2);
 assert.equal(report.all_valid[model].pass_rate,.5);
 assert.equal(report.all_valid[model].environment,1);
 assert.equal(report.all_valid[model].mean_tokens_total,35,'normal task token mean');
 execFileSync('node',['eval/harness/review.mjs',out]);
 assert.match(await readFile(join(out,'review.html'),'utf8'),/1 条站点不可用/);
 assert.match(await readFile(join(out,'review.html'),'utf8'),/1\/2 做对/);
 console.log('PASS report: 1/2, environment=1');

 if(!reportOnly){
 const scheduled=tasks.slice(0,3).map((id:string)=>({...all.find((task:any)=>task.id===id),site_url:origin+'/limited',prompt:'读取fixture验证页面'}));
 await writeFile(join(out,'scheduled-tasks.jsonl'),scheduled.map((t:any)=>JSON.stringify(t)).join('\n'));
 const {stdout:scheduleLog}=await promisify(execFile)('node',['eval/harness/run.mjs','--models','zai-coding-cn/glm-5.3-flash','--tasks',scheduled.map((t:any)=>t.id).join(','),'--concurrency','3','--retries','0','--run-id','same-site','--no-judge'],{env:{...process.env,BYS_TASKS:join(out,'scheduled-tasks.jsonl'),BYS_RUNS_DIR:join(out,'scheduled')},encoding:'utf8',timeout:90000});
 let active=0;

 for(const line of scheduleLog.split('\n')){if(line.includes('] start ')){active++;assert.equal(active,1,'same-host jobs overlapped');}

if(line.includes(' -> environment '))active--;}

 assert.equal(active,0);
 await writeFile(join(out,'schedule.log'),scheduleLog);
 console.log('PASS same-host scheduling');
 }

 await writeFile(join(out,'acceptance.json'),JSON.stringify({pass:true,reportOnly,out},null,2));
}finally{server.closeAllConnections();server.close();}

console.log(out);
