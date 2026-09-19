/** Production panel/background + TaskProgress projection; controlled host, zero model calls. */
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {TaskProgress} from '../../agent/src/task-progress.js';
import {projectTaskView} from '../../shared/task-view.js';
import {startTaskBarHarness, sleep, until} from './task-bar-harness.mts';

if (!process.argv.includes('--headless')) throw new Error('Required: --headless');
const out = resolve('out/acceptance', `${new Date().toISOString().replace(/[:.]/g, '-')}-materials-reopen`);
mkdirSync(out, {recursive:true});
const h = await startTaskBarHarness({controlled:true, outDir:join(out, 'harness')});
const checks: {name:string; passed:boolean}[] = [];
const text = async () => String(await h.panel("document.querySelector('#task-bar-root')?.textContent ?? ''"));
const check = (name:string, passed:boolean) => { checks.push({name,passed}); if (!passed) throw new Error(name); };
try {
  const original = new TaskProgress('default');
  original.request('核对报名材料', {tabId:7,title:'报名表',url:'https://fixture.test/form',selection:{text:'指定段落'}},
    [{id:'image-1',type:'image',name:'报名截图.png',mimeType:'image/png',dataBase64:'AQ=='}]);
  original.observe({type:'agent_event',event:{kind:'agent_start'}});
  // JSON round trip and fresh host state: no live UI cache supplies material facts.
  const restored = new TaskProgress('default');
  restored.restoreResults(JSON.parse(JSON.stringify(original.snapshot())));
  const view = projectTaskView(restored.snapshot());
  h.sendTaskView(view as unknown as Record<string,unknown>);
  await until(async () => (await text()).includes('报名截图.png') || undefined, 8000, '材料首次呈现');
  check('host-materials-visible', (await text()).includes('指定段落'));
  await h.panel('location.reload()').catch(() => undefined);
  await sleep(1200);
  await until(async () => (await text()).includes('报名截图.png') || undefined, 15000, '重开后材料恢复');
  const reopenedText = await text();
  check('reopen-retains-all-materials', ['报名表','指定段落','报名截图.png'].every(label => reopenedText.includes(label)));
  check('accepted-materials-not-removable', await h.panel("document.querySelectorAll('.tb-materials button[data-remove-key]').length") === 0);
  h.sendTaskView({...view, conversationId:'other', goal:'不该出现', materials:[{key:'other',kind:'attachment',label:'其他会话.png'}]} as unknown as Record<string,unknown>);
  await sleep(200);
  check('other-conversation-rejected', !(await text()).includes('其他会话.png'));
  const next = new TaskProgress('default');
  next.request('下一任务');
  next.observe({type:'agent_event',event:{kind:'agent_start'}});
  h.sendTaskView(projectTaskView(next.snapshot()) as unknown as Record<string,unknown>);
  await until(async () => (await text()).includes('下一任务') || undefined, 5000, '新任务');
  check('new-run-clears-old-materials', !(await text()).includes('报名截图.png'));
  check('no-panel-errors', h.pageErrors.length === 0);
} catch (error) {
  checks.push({name:String(error),passed:false});
  process.exitCode = 1;
} finally {
  writeFileSync(join(out,'result.json'), JSON.stringify({checks, boundary:'Controlled host; production panel/background; zero model calls; not human acceptance'},null,2));
  console.log(JSON.stringify({out,checks},null,2));
  await h.close();
}
