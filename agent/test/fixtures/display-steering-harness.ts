/**
 * Shared harness for the runtime display-steering tests.
 *
 * Test files must mock `../src/display-fast-path.js` (decideDisplay / displaySteerFastPathEnabled)
 * and `../src/run-trace.js` before importing this module; the harness uses the production
 * `createBrowserTools` gate so the correction fence is exercised for real.
 */
import {vi} from 'vitest';
import {BrowserAgentSession} from '../../src/session.js';
import {createBrowserTools} from '../../src/tools.js';
import {ConversationManager} from '../../src/conversation-manager.js';
import {TaskDispatcher} from '../../src/task-dispatcher.js';
import type {AgentUiEvent,PageContext,ServerMessage} from '../../../shared/protocol.js';

export type DisplayState={document:string;translated:number;displayValid:boolean;mode:'bilingual'|'translated';fontFamily:'original'|'songti'};
export type DecisionParams=Record<string,unknown>;
export const context:PageContext={tabId:7,title:'文章',url:'https://fixture.test/a'};
export const candidate=(params:DecisionParams)=>({kind:'candidate' as const,params:{action:'display' as const,...params},reason:'accepted' as const});

export function pageHarness(options?:{streaming?:boolean;emit?:(event:AgentUiEvent)=>void;setStatus?:(state:any)=>void}){
 const pageState:DisplayState={document:'one',translated:1,displayValid:true,mode:'translated',fontFamily:'original'};
 const translationCalls:Array<Record<string,unknown>>=[];
 const facts=new Map<string,string>();
 const forced=new Map<string,string>();
 let pageFailure:{error:Error;fact:string}|null=null;
 const rpc:any={
  call:vi.fn(async(name:string,params:any,_t?:number,_s?:string,_p?:string,_epoch?:number,sdkId?:string)=>{
   if(name==='snapshot')return {text:'译文',tabId:params?.tabId??7,translation:{...pageState}};
   if(name==='page_translation'){
    translationCalls.push({...params});
    if(pageFailure){const failure=pageFailure;pageFailure=null;if(sdkId)facts.set(sdkId,failure.fact);throw failure.error;}
    if(params.action==='display'){
     if(params.document&&params.document!==pageState.document)return {error:'页面已变化',executionFact:'not_executed'};
     if(params.fontFamily)pageState.fontFamily=params.fontFamily;
     if(params.mode)pageState.mode=params.mode;
     if(sdkId)facts.set(sdkId,'executed');
     return {tabId:params.tabId??7,document:pageState.document,language:'zh',mode:pageState.mode,fontSize:null,translated:1,remaining:0,unsupported:0,blocks:[]};
    }
    if(sdkId)facts.set(sdkId,'executed');
    return {tabId:params.tabId??7,document:pageState.document};
   }
   if(sdkId)facts.set(sdkId,'executed');
   return {};
  }),
  getExecutionFact:(id:string)=>forced.get('page_translation')??facts.get(id)??'executed',
  getPageTarget:()=>null,
  setPageTarget:vi.fn(),
  resolvePageParams:(_name:string,params:Record<string,unknown>)=>params,
 };
 let streaming=options?.streaming??true;
 let subscriber:((event:unknown)=>void)|null=null;
 const emitted:AgentUiEvent[]=[];
 const forwardEmit=options?.emit;
 const steers:string[]=[];
 let runId='run-1';
 let wrapper:any;
 const tools=createBrowserTools(rpc,undefined,undefined,undefined,{
  epoch:()=>wrapper?.executionEpoch?.()??0,
  canWrite:(toolCallId?:string)=>wrapper?.canWriteCurrentInput(toolCallId)??false,
  assertCall:(name:string,params:Record<string,unknown>,toolCallId?:string)=>wrapper?.assertTaskResultExecution(name,params,toolCallId),
 } as never);
 const raw:any={
  get isStreaming(){return streaming;},
  model:{id:'test'},
  agent:{state:{tools,messages:[]}},
  abort:vi.fn(async()=>{streaming=false;}),
  prompt:vi.fn(async()=>{}),
  steer:vi.fn(async(text:string)=>{steers.push(text);}),
  clearQueue:vi.fn(()=>({steering:[],followUp:[]})),
  subscribe:vi.fn((fn:any)=>{subscriber=fn;return ()=>{};}),
  sessionManager:{appendCustomEntry:vi.fn(),getBranch:()=>[]},
 };
 wrapper=new (BrowserAgentSession as any)(raw,null,{emit:(event:AgentUiEvent)=>{emitted.push(event);forwardEmit?.(event);},setStatus:options?.setStatus??vi.fn()},null,null,undefined,null,rpc);
 wrapper.explicitDelivery=true;wrapper.modeState={value:'act'};wrapper.deliveryRunId=()=>runId;wrapper.activeGoal='读取这篇文章';
 wrapper.subscribeEvents();
 return {
  wrapper,raw,rpc,emitted,steers,pageState,translationCalls,
  setStreaming:(value:boolean)=>{streaming=value;},
  setRunId:(value:string)=>{runId=value;},
  failNextPageTranslation:(error:Error,fact='unknown')=>{pageFailure={error,fact};},
  forceFact:(name:string,fact:string)=>forced.set(name,fact),
  messageStart:(text:string)=>subscriber?.({type:'message_start',message:{role:'user',content:text}}),
  agentEnd:()=>subscriber?.({type:'agent_end',messages:[]}),
  agentStart:()=>subscriber?.({type:'agent_start'}),
  event:(value:unknown)=>subscriber?.(value),
  tool:(name:string)=>raw.agent.state.tools.find((tool:any)=>tool.name===name),
 };
}

export async function managerHarness(){
 const emitted:ServerMessage[]=[];
 let conversationEmit:(message:ServerMessage)=>void=()=>{};
 let harness:ReturnType<typeof pageHarness>|null=null;
 const manager=new ConversationManager(async(_id,emit)=>{
  conversationEmit=emit;
  harness=pageHarness({
   emit:event=>emit({type:'agent_event',event}),
   setStatus:state=>emit({type:'status',state}),
  });
  const h=harness;
  return {
   session:h.wrapper,
   fleet:{reset:vi.fn(),isGroupHeld:()=>false,teamView:()=>null,list:()=>[],get:()=>undefined,abortTeam:vi.fn(),reviseSharedRequirement:vi.fn(async()=>({notified:[],queued:[],skipped:[],failed:[]}))},
   rpc:h.rpc,
   handleMessage:vi.fn(),
   dispose:vi.fn(),
  } as never;
 },(message)=>emitted.push(message),undefined,undefined,undefined,new TaskDispatcher());
 const entry=await manager.ensureDefault();
 const h=harness!;
 conversationEmit({type:'agent_event',conversationId:'default',event:{kind:'agent_start'}} as ServerMessage);
 return {h,manager,entry,emitted};
}
