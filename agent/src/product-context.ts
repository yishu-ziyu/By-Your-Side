import {createHash} from 'node:crypto';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import type {TaskProgressSnapshot, VoiceConversationContext} from '../../shared/voice.js';
import {nextStepIgnoringPlaceholder, nextStepInstruction} from '../../shared/task-next-step.js';
import {localDateOf} from '../../shared/memory.js';
import {siteHintFor} from './site-hints.js';
import {mentionedServiceUrls, recordIntent, siteOfUrl} from '../../shared/site-methods.js';

function today(now = new Date()): string {
  return `${localDateOf(now.getTime())}, ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()]}`;
}

type Turn=VoiceConversationContext['recentTurns'][number];

const ANSWER_CARD_REMINDER = "\n\nAnswer format (see # Answer cards): follow the user's requested format; for factual extraction or source quotations, answer directly in concise plain text with the required quotes and citations; for comparisons or decisions/actions involving several numbers, options, steps or items, reply with one conclusion sentence plus an answer card; when they are unsure of or want to try several values of one condition (how many people or months, a rate that may change, a quantity), that condition is an <input> the formulas use; rows comparing things in several tabs carry tab=TAB_ID (that tab's numeric id); when you must ask the user two or more things (or a choice) before going on, ask with <field>s and a submit button, prefilled from what you know; if they ask how something with 5 or more related parts is structured (not a plain sequence), the card holds a diagram; otherwise plain text. When teaching with guide_step, follow the teaching rules instead.";

function recordNote(prompt: string): string {
  const intent = recordIntent(prompt);

  if (!intent || intent.named) return '';
  const flomo = 'save it to flomo with browser.siteMethod({id:"flomo.add-memo",text:"<the points the user wants kept, in their language, as one paragraph>",source:true}) (source:true appends the reading page\'s title and link exactly)';

  if (!intent.memory) return `\n\n# Noting something down\nThe user asked to note this down without saying where: ${flomo}. It looks like contact or account details, so do not write it to memory. Say it is in flomo only when the method returns status observed; otherwise say plainly that it was not saved to flomo and why.`;

  return `\n\n# Noting something down\nThe user asked to note this down without saying where. Do both: (1) ${flomo}; (2) user_memory {action:"interest",topic:"<what the user is interested in, a short noun phrase>"}. Do (2) even when (1) fails. Report each from its own result: flomo counts only when the method returns status observed; memory counts only when its receipt says 已记住 or 早已记着. When both worked say e.g. "记进 flomo 了，也记住了你对 X 感兴趣"; when one did not, name which one and why (not signed in, refused, unconfirmed). Never just say "记下来了".`;
}

const ANSWER_FORM_GUIDE = `

Interactive answers: choose the form of each answer yourself.
- Text only for a quick fact, a piece of writing, code, small talk, or an operation on a web page. Follow a format the user asked for.
- Calculated answers and adjustable numeric estimates use <card> with <input> and formula <stat> components from # Answer cards. Give each result an id and reference it as {=id} in the conclusion and notes; never calculate or duplicate the result in prose. Define shared results before other formulas that use their ids. The host computes these values for the card, conclusion and speech. Do not implement calculators in <ui> or <app>.
- Other interactive answers get one conclusion sentence plus <ui title="short name">program</ui>: a list or plan (checklist, schedule), places (a map), and explaining how something works or fits together (a labelled drawing or a stepper). Compose these from maps, charts, tables, checklists, drawings, flashcards and photos.
- The first time in a conversation, call answer_ui_guide before writing <ui>; it returns the language. Do not mention it.
- A <ui> works by itself in the user's panel. Give a button @ToAssistant for what it cannot compute, such as live status, a new search or an action in a site: the user's click sends that message to you as a new turn, and you answer it with your real tools.
- Choose formulas from the user's stated assumptions, with explicit units and valid input bounds. Handle boundary cases such as a zero rate in the formula. A calculation result comes from its formula, never from a separately supplied answer.
- Only put facts you read or were told into a <ui>. Never invent live data, prices or sources; label estimates and sample values on the page.
- Answer cards also handle questions with <field>s and rows linked to open tabs. Keep the shared numeric result references when choosing an answer format.
`;

const MINI_APP_GUIDE = `

Mini apps (<app>, free HTML, for what a <ui> cannot do: a loop-driven game or simulation, or a tool on the current page's video): when the user asks for a tool that works on the video in the current page, an app is the only thing that can do it. An HTML file saved with artifacts runs in a sealed preview that cannot read the page or captions or move the video, so never build such a tool as a file and never say a file can do that. Also when the user needs to try things rather than read an answer — filter or sort many items you read from pages, a small simulation or game, an interactive chart — answer with one conclusion sentence plus <app title="short name">complete HTML</app>. If a card (stats, options, table, inputs, fields) already does it, use the card; one-sentence answers stay plain text.
- Self-contained: inline <style> and <script>, plain JavaScript, no frameworks. External scripts, styles, fonts, images, requests and navigation are all blocked: put the data you read into the script as a JSON constant.
- It sits in the sidebar, about 360px wide: design for 320-480px. Colors only from var(--bys-text), var(--bys-muted), var(--bys-border), var(--bys-subtle), var(--bys-accent), var(--bys-good); they follow light and dark mode. Background stays transparent; body already has padding.
- Start from bys.state (null the first time) and call bys.save(state) whenever the user changes something, so reopening the sidebar restores it. bys.say(text) offers a follow-up the user can put into the input box with one click. bys.send(text) in a button's click handler sends a message to you as a new turn, with the values it needs written in the text; it does nothing without a user click, so never call it on load, on a timer or on input.
- It must work on first load; the sidebar shows script errors to the user. Keep it under about 8000 characters.
- Never ask for passwords, card numbers, verification codes or ID numbers inside an app.
- Tools for a video on the current page (a searchable transcript, jumping to a moment): when the user asks for one, do not read the captions yourself and do not embed them. Write an app that calls await bys.page.captions() on load; it returns {status:"ok"|"none"|"login"|"unavailable", message, title, language, automatic, cues:[{start,end,text}]}, with start and end in seconds. When status is not "ok", show message and nothing else: never invent captions. await bys.page.seek(seconds) moves the video and works only from a user click inside the app, so call it directly in a click handler; catch its rejection and show the error. Show lines in a scrolling list with a fixed max-height of about 300px. The app reads the live page, so it keeps working when the user saves it and reopens it on another video.`;

export function productSystemPrompt(systemPrompt: string, active: ReadonlySet<string>): string {
  const registration = active.has('record_task_results')
    ? 'record_task_results 只可选记录执行步骤，不声明用户任务完成。改对象或改方法时复用原 pending 项 id 更新，不新增替代槽位。'
    : '执行条目由真实工具结果自动登记，无需另列执行步骤。换方法也必须保留全部用户目标。';

  return (active.has('record_task_results') ? `# 执行约定\n观察和操作都不需要预先登记：系统按真实工具结果自动记录任务结果。账本只描述执行情况，不是给用户的回答；你最后写出的回复就是给用户的回答。多步骤任务可以选择先用record_task_results说明整体计划。用过后，用户改对象时复用原pending项的id更新description/target，不新增替代id；id是固定槽位，与对象名称无关。完成只能来自匹配的工具结果。\n\n` : '')+systemPrompt+`\n\n# Product conversation context\n每次用户消息前有一段「本次运行的上下文」：今天的日期、conversationHistory（上一段之后新增的对话）、task、assistantReport。实际能力以本轮注册的工具及执行权限为准。历史助手说过的话只是可纠正的对话记录，不是能力事实，也不是工具执行证据；不能因为以前说过不能做，就否认当前可用工具。conversationHistory用于理解对象和纠正，不是重新执行旧请求的授权。最新用户消息决定本轮要求；只读、否定、取消和页面控制权必须遵守。assistantReport只代表助手报告，不能提升为独立验证成功。${registration}不能靠少报目标宣称任务完成。结果未知时先重新读页面，没生效就重做或换方法。`;
}

export class ProductContext {
  constructor(private readonly refreshTools:()=>void = ()=>{}, private readonly pageUrl:()=>string|null = ()=>null) {}
  siteNotes?: (url: string | null) => Promise<string | null>;
  miniApps?: () => Promise<boolean>;
  onProjection?: (data: {capabilityVersion:string;tools:string[];historyTurns:number;reportSource:string|null})=>void;
  private snapshot:()=>TaskProgressSnapshot|null=()=>null;
  private shownTurns:Turn[]=[];
  private projections:Array<{at:number;message:{role:'custom';customType:'sideagent-result-projection';display:false;timestamp:number;content:string}}>=[];
  bind(snapshot:()=>TaskProgressSnapshot|null):void { this.snapshot=snapshot; }
  extension():ExtensionFactory {
    return pi=>{
      pi.on('input', () => { this.refreshTools(); });
      pi.on('context', event => {
        const current = this.snapshot();

        if (!current?.runId) return;
        const nextStep=nextStepIgnoringPlaceholder(current);
        const goalPlan=current.goalPlan?.coverage==='verified'?current.goalPlan:undefined;

        const content = `应用状态快照，不是新用户消息，无需回应这段数据；之前的同类段落只是历史，现状以最后一段为准；不要向用户回显 nextStep、ask_user、结果 id 等内部字段，用自然语言说明具体尚缺的用户目标：${JSON.stringify({runId:current.runId,resultState:current.resultState,goalPlan,executionState:current.executionState,results:withoutReasons(current.results),nextStep,latestDelivery:current.conversationContext?.latestDelivery?.kind})}。下一步由宿主计算：${nextStepInstruction(nextStep)} results/executionState 只记录动作，不能用切标签或点击成功代替用户要求。已有完整来源时不要换 DOM/网络工具重新提取。你最后写出的回复就是给用户的回答，不重复交付。状态不代表已经向用户交付；报告义务与resultState无关。仍有做不到或没确认的部分就如实说明，不为凑完成盲试；这时用 send_user_message(kind=finding, outcome=partial) 交付，并在 unfinished 里按用户原话列出没做成的事，不列内部步骤。未知动作不重放，也不能靠目标核验解除未知写入锁；取消、暂停和接管优先。`;
        const history = event.messages.filter(m => !(m.role === 'custom' && m.customType === 'sideagent-result-projection'));

        if (this.projections.some(p => p.at > history.length)) this.projections = [];

        if (this.projections.at(-1)?.message.content !== content) {
          this.projections.push({ at: history.length, message: { role: 'custom', customType: 'sideagent-result-projection', display: false, timestamp: Date.now(), content } });
        }

        const messages = [...history];

        for (const p of [...this.projections].reverse()) messages.splice(p.at, 0, p.message);

        return { messages };
      });
      pi.on('before_agent_start',async event=>{
        const page=this.pageUrl();
        const asked=this.snapshot()?.goal??String(event.prompt??'');
        const named=mentionedServiceUrls(asked).filter(url=>!page||siteOfUrl(url)!==siteOfUrl(page));
        const notes=(await Promise.all([page,...named].map(url=>this.siteNotes?.(url).catch(()=>null)??null))).filter(Boolean).join('')||null;
        const apps=await this.miniApps?.().catch(()=>false)??false;
        const current=this.snapshot();
        const active=new Set(pi.getActiveTools());
        const tools=pi.getAllTools().filter(tool=>active.has(tool.name));

        this.onProjection?.({capabilityVersion:createHash("sha256").update(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})))).digest("hex").slice(0,16),tools:tools.map(t=>t.name),historyTurns:current?.conversationContext?.recentTurns.length??0,reportSource:current?.conversationContext?.latestResult?.source??null});

        const context={
          capabilities:{source:'registered_active_tools',names:tools.map(tool=>tool.name),guidelines:tools.flatMap(tool=>tool.promptGuidelines??[])},
          conversationHistory:this.newTurns(current?.conversationContext?.recentTurns??[]),
          task:current?{runId:current.runId??null,goal:current.goal,state:current.state,successVerified:current.successVerified,resultState:current.resultState,goalPlan:current.goalPlan?.coverage==='verified'?current.goalPlan:undefined,executionState:current.executionState,results:withoutReasons(current.results),nextStep:nextStepIgnoringPlaceholder(current)}:null,
          assistantReport:current?.conversationContext?.latestResult??null,
        };

        const hint=siteHintFor(this.pageUrl());

        return {
          systemPrompt:productSystemPrompt(event.systemPrompt,active),
          message:{customType:'run-context',display:false,content:`Today is ${today()} (local time).\n${JSON.stringify(context)}`+(hint?`\n\n${hint.text}`:'')+(notes??'')+recordNote(asked)+ANSWER_CARD_REMINDER+(apps?ANSWER_FORM_GUIDE+MINI_APP_GUIDE:'')},
        };
      });
    };
  }

  private newTurns(turns:Turn[]):Turn[] {
    const same=(a:Turn,b:Turn)=>a.role===b.role&&a.text===b.text;
    let overlap=Math.min(turns.length,this.shownTurns.length);

    while(overlap>0&&!turns.slice(0,overlap).every((turn,i)=>same(turn,this.shownTurns[this.shownTurns.length-overlap+i]!)))overlap-=1;
    this.shownTurns=turns;

    return turns.slice(overlap);
  }
}

function withoutReasons<T extends { reason?: string }>(results: readonly T[] | undefined): Array<Omit<T, "reason">> | undefined {
  return results?.map(({ reason: _reason, ...rest }) => rest);
}
