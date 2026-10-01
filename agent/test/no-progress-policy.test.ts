/**
 * 原地转圈（docs/evals/20261001-data-to-file.md 标准 7、8）。先列失败方式，再写实现：
 * F1 同一份数据换个切法重读（分段数、截断边界、计数字段变了）被当成新信息，永远不停（10-01 B 站记录）。
 * F2 同样的结果、同样的目标清单反复读，没有页面变化，也不停。
 * F3 同一个错误换个写法反复撞（参数每次不同，连续失败保护按参数计数认不出），不停。
 * F4 读回自己刚写的文件被当成新信息。
 * F5 整页翻译多批、每批内容不同，被误停。
 * F6 多页逐项操作（回执文字相同的点击、程序里的点击）被误停。
 * F7 轮询一个在变的下载进度被误停；带等待的轮询被误停。
 * F8 连续读几个不同页面（共用导航栏）被误停。
 * F9 回放 10-01 记录时在 11:59 生成文件之前就停（模型自己正式交代进展之前），或到 429 都不停。
 * F10 上一个任务的记录带进新任务，新任务一开始就被停。
 * F11 停下后又停一次。
 * F12 停下时的话说「还差：提取字幕」（已经取到的东西当成没做），或露出工具名、没说已有什么。
 * F13 只变了时间戳、编号这类易变字段的结果被当成新信息。
 * F14 用户插话后计数清零，停下时却说「还没有生成文件」；删掉的文件仍列出（会话级，见 no-progress-session.test.ts）。
 * F15 程序里存文件（同名同大小覆盖）被当成没进展。
 * F16 程序里等一下（waitForLoad、sleep）再读同样的东西，就永远不算原地打转。
 */
import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {NO_PROGRESS_LIMIT, NoProgressPolicy, noProgressMessage, type NoProgressStop} from '../src/no-progress-policy.js';

interface ToolInput {command?:string;filename?:string;content?:string;target?:string;code?:string;part?:number}

type Call = {toolName:string;text:string;isError?:boolean;input?:ToolInput;steps?:Array<{name:string;error?:string}>};

function setup() {
  const handlers:Record<string,Function>={};
  const stops:NoProgressStop[]=[];
  const abort=vi.fn();
  const policy=new NoProgressPolicy(stop=>stops.push(stop));
  // SAFETY: 测试替身只实现策略用到的 on；事件名与处理函数形状同真实钩子。
  policy.extension()({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any);
  let n=0;

  const run=(call:Call)=>{
    const toolCallId=`c${n++}`;

    for(const step of call.steps??[]){
      const ended:Parameters<NoProgressPolicy['noteProgramStep']>[0]={parentId:toolCallId,name:step.name,phase:'end'};

      if(step.error)ended.error=step.error;
      policy.noteProgramStep(ended);
    }

    handlers.tool_result!({toolName:call.toolName,toolCallId,isError:!!call.isError,input:call.input??{},content:[{type:'text',text:call.text}]},{abort});

    return abort.mock.calls.length>0;
  };

  return {policy,stops,abort,run};
}

/** 10-01 B 站记录的去标识回放：每段结果只保留「第几个不同的片段」编号，不含字幕原文。 */
interface TraceCall {t:string;tool:string;isError:boolean;command?:string;segs:string;written?:string}

// SAFETY: 夹具由仓库外的原始记录按 source 字段所述一次性导出，形状即 TraceCall[]。
const trace=JSON.parse(readFileSync(new URL('./fixtures/bilibili-stall-20261001.json',import.meta.url),'utf8')) as {calls:TraceCall[]};

function expand(ranges:string):string {
  if(!ranges)return '';

  return ranges.split(',').flatMap(part=>{const [a,b=a]=part.split('-').map(Number);

return Array.from({length:b!-a!+1},(_,i)=>`s${a!+i}`);}).join('\n');
}

describe('no-progress stop: the 10-01 Bilibili trace',()=>{
  it('fires at the sixth consecutive no-progress call after the file was created, not before 11:59 and well before the 429 (F1–F4, F9)',()=>{
    const h=setup();
    let firedAt:string|null=null;

    for(const call of trace.calls){
      const input:ToolInput={};

      if(call.command){input.command=call.command;input.filename='subtitles.srt';}

      if(call.written)input.content=expand(call.written);

      if(h.run({toolName:call.tool,text:expand(call.segs),isError:call.isError,input})){firedAt=call.t;break;}
    }

    // 手算（见 docs/evals/20261001-data-to-file.md 标准 7 的回放表）：11:59:44 生成文件后，
    // 12:01:00 目标清单重读、12:02:10/12:02:43/12:02:57/12:03:55 重读字幕、12:05:20 目标清单重读 = 第 6 步。
    expect(firedAt).toBe('12:05:20');
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0]).toMatchObject({streak:NO_PROGRESS_LIMIT,toolName:'browser_run'});
  });
});

describe('no-progress stop: normal long tasks keep running',()=>{
  it('page translation in many batches with different text (F5)',()=>{
    const h=setup();

    for(let batch=0;batch<14;batch++){
      expect(h.run({toolName:'read_elements',text:JSON.stringify({blocks:Array.from({length:20},(_,i)=>`Paragraph ${batch}-${i}: original sentence number ${batch*20+i}.`)})})).toBe(false);
      expect(h.run({toolName:'page_translation',text:JSON.stringify({applied:20,translated:Array.from({length:20},(_,i)=>`第 ${batch}-${i} 段：译文第 ${batch*20+i} 句。`)})})).toBe(false);
    }
  });

  it('multi-page item-by-item operations with identical click receipts and in-program clicks (F6)',()=>{
    const h=setup();

    for(let page=1;page<=3;page++){
      for(let item=1;item<=8;item++)expect(h.run({toolName:'click',text:'已点击',input:{target:`@${item}`}})).toBe(false);

      for(let item=1;item<=8;item++)expect(h.run({toolName:'browser_run',text:'{"value":"{\\"ok\\":true}","steps":2}',steps:[{name:'click'},{name:'snapshot'}]})).toBe(false);

      expect(h.run({toolName:'navigate',text:`已打开第 ${page+1} 页`})).toBe(false);
    }
  });

  it('polling a download whose progress changes, and an unchanged poll that waits between reads (F7)',()=>{
    const h=setup();

    for(let i=1;i<=20;i++)expect(h.run({toolName:'browser_run',text:JSON.stringify({state:'in_progress',bytesReceived:i*524288,totalBytes:10485760,filename:'report.zip'})})).toBe(false);

    for(let i=0;i<10;i++)expect(h.run({toolName:'browser_run',text:'{"state":"rendering","percent":"处理中"}',steps:[{name:'sleep'},{name:'snapshot'}]})).toBe(false);
  });

  it('reading several different pages that share navigation (F8)',()=>{
    const h=setup();
    const nav=Array.from({length:40},(_,i)=>`导航 ${['首页','产品','价格','文档','博客'][i%5]} ${i}`);

    for(let page=0;page<12;page++){
      const body=Array.from({length:60},(_,i)=>`第 ${page} 篇文章的第 ${i} 段，讨论主题 ${page*60+i}`);
      expect(h.run({toolName:'snapshot',text:[...nav,...body].join('\n')})).toBe(false);
    }
  });
});

describe('no-progress stop: the signal itself',()=>{
  it('identical results whose only change is volatile ids and timestamps count as no progress (F2, F13)',()=>{
    const h=setup();
    const poll=(i:number)=>JSON.stringify({id:`3f2b8c1e-0000-4000-8000-00000000000${i}`,checkedAt:`2026-10-01T12:0${i}:00.000Z`,at:1790855521704+i*1000,state:'in_progress',bytesReceived:1024});

    for(let i=0;i<NO_PROGRESS_LIMIT;i++)expect(h.run({toolName:'browser_run',text:poll(i)})).toBe(false);
    // 第一次是新信息；之后连续 NO_PROGRESS_LIMIT 次没有新东西才停。
    expect(h.run({toolName:'browser_run',text:poll(7)})).toBe(true);
  });

  it('re-reading the same data with page JavaScript counts: js and browser.js are judged by their result (F2)',()=>{
    const h=setup();
    const data=JSON.stringify({count:830,rows:Array.from({length:60},(_,i)=>`row ${i}`)});
    h.run({toolName:'js',text:data});

    for(let i=0;i<NO_PROGRESS_LIMIT-1;i++)expect(h.run({toolName:i%2?'js':'browser_run',text:data,steps:[{name:'js'}]})).toBe(false);
    expect(h.run({toolName:'js',text:data})).toBe(true);
  });

  it('the same error under different code is counted; a first-seen error alone neither counts nor resets (F3)',()=>{
    const h=setup();
    h.run({toolName:'browser_run',text:'{"rows":12}'});

    for(let i=0;i<10;i++)expect(h.run({toolName:'browser_run',text:`err-${i} is not defined`,isError:true,input:{code:`v${i}`}})).toBe(false);
    h.run({toolName:'browser_run',text:'{"rows":13}'});

    for(let i=1;i<NO_PROGRESS_LIMIT;i++)expect(h.run({toolName:'browser_run',text:"'Blob' is not defined",isError:true,input:{code:`attempt ${i}`}})).toBe(false);
    // 第 1 次是新错误（不计）；之后第 2…第 7 次是同一个错误。
    expect(h.run({toolName:'browser_run',text:"'Blob' is not defined",isError:true,input:{code:'attempt 6'}})).toBe(false);
    expect(h.run({toolName:'browser_run',text:"'Blob' is not defined",isError:true,input:{code:'attempt 7'}})).toBe(true);
  });

  it('reading back a file the task wrote is not new information (F4)',()=>{
    const h=setup();
    const file=Array.from({length:30},(_,i)=>`${i+1}\n00:00:${String(i).padStart(2,'0')},000 --> 00:00:${String(i+1).padStart(2,'0')},000\n第 ${i} 句`).join('\n\n');
    h.run({toolName:'artifacts',text:'已创建 a.srt（900 字符）',input:{command:'create',filename:'a.srt',content:file}});

    for(let i=0;i<NO_PROGRESS_LIMIT-1;i++)expect(h.run({toolName:'artifacts',text:file,input:{command:'get',filename:'a.srt'}})).toBe(false);
    expect(h.run({toolName:'artifacts',text:file,input:{command:'get',filename:'a.srt'}})).toBe(true);
  });

  it('a delivery to the user resets the streak; a new task starts clean; it stops only once (F10, F11)',()=>{
    const h=setup();
    h.run({toolName:'snapshot',text:'same page'});

    for(let i=0;i<NO_PROGRESS_LIMIT-1;i++)h.run({toolName:'snapshot',text:'same page'});
    h.run({toolName:'send_user_message',text:'delivered:delivery-0123456789abcdef0123456789abcdef'});

    for(let i=0;i<NO_PROGRESS_LIMIT-1;i++)expect(h.run({toolName:'snapshot',text:'same page'})).toBe(false);
    // 第二次交付的回执与第一次只差编号（易变字段），它仍是给用户的交付，照样清零。
    h.run({toolName:'send_user_message',text:'delivered:delivery-fedcba9876543210fedcba9876543210'});

    for(let i=0;i<NO_PROGRESS_LIMIT-1;i++)expect(h.run({toolName:'snapshot',text:'same page'})).toBe(false);
    h.policy.reset();
    expect(h.run({toolName:'snapshot',text:'same page'})).toBe(false);

    for(let i=0;i<NO_PROGRESS_LIMIT;i++)h.run({toolName:'snapshot',text:'same page'});
    h.run({toolName:'snapshot',text:'same page'});
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.stops).toHaveLength(1);
  });

  it('a program that saves a file is a file change, even when it overwrites the same name with the same size (F15)',()=>{
    const h=setup();
    const receipt='{"value":"{\\"filename\\":\\"rows.csv\\",\\"chars\\":43315,\\"lines\\":831,\\"overwritten\\":true}","steps":1}';

    for(let i=0;i<NO_PROGRESS_LIMIT*2;i++)expect(h.run({toolName:'browser_run',text:receipt,steps:[{name:'saveFile'}]})).toBe(false);
  });

  it('waiting inside a program does not exempt an endless identical re-read: waited reads count half (F16)',()=>{
    const h=setup();
    const poll=()=>h.run({toolName:'browser_run',text:'{"state":"rendering","percent":"处理中"}',steps:[{name:'waitForLoad'},{name:'snapshot'}]});
    expect(poll()).toBe(false);

    // 第一次是新信息；之后每次等待后的同样读数记半步，连续 2×NO_PROGRESS_LIMIT 次才停。
    for(let i=1;i<NO_PROGRESS_LIMIT*2;i++)expect(poll()).toBe(false);
    expect(poll()).toBe(true);
  });
});

describe('no-progress stop: what the user is told (F12)',()=>{
  it('names the step in plain words, what exists, and what is missing from the latest goal check, not the unverified plan',()=>{
    const message=noProgressMessage({toolName:'browser_run',streak:6,
      files:[{filename:'火线8-10集解说字幕.srt',chars:34005,lines:2632}],
      satisfied:[], missing:'保存字幕为文件', unverified:['提取当前 B 站视频的字幕文本','把字幕保存成文件交付给用户']});

    expect(message.text).toBe('「连续操作网页」这一步在原地打转：连续 6 步都是重读已经拿到的内容或重复同样的错误，没有新进展，我先停下了。已有：文件「火线8-10集解说字幕.srt」（34005 字，2632 行）。还差：保存字幕为文件。');
    expect(message.unfinished).toEqual(['保存字幕为文件']);
    expect(message.text).not.toMatch(/browser_run|提取当前/);
  });

  it('without a goal check it lists unverified goals as unconfirmed, not as not done; with nothing obtained it says so',()=>{
    const message=noProgressMessage({toolName:'snapshot',streak:6,files:[],satisfied:['打开订单页'],missing:null,unverified:['导出订单']});

    expect(message.text).toBe('「读取页面」这一步在原地打转：连续 6 步都是重读已经拿到的内容或重复同样的错误，没有新进展，我先停下了。已有：已核对完成「打开订单页」。还没确认完成：导出订单。');
    expect(message.unfinished).toEqual(['导出订单']);
    expect(noProgressMessage({toolName:'snapshot',streak:6,files:[],satisfied:[],missing:null,unverified:[]}).text).toBe('「读取页面」这一步在原地打转：连续 6 步都是重读已经拿到的内容或重复同样的错误，没有新进展，我先停下了。已有：还没有生成文件或核对完成的结果。');
  });
});
