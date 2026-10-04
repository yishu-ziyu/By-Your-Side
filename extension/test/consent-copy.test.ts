import {describe,expect,it} from 'vitest';
import {consentDetailsText, consentHeading, consentStatusText, consentTargetText} from '../src/sidepanel/consent.js';
import type {FetchConsentRequest, WriteConsentRequest} from '../../shared/consent.js';

const fetchRequest: FetchConsentRequest = {id:'fetch-1',conversationId:'default',runId:'run-1',controlVersion:0,url:'https://example.test/api',method:'POST',headers:{'content-type':'application/json'},body:'{"n":1}',expiresAt:Date.now()+60_000};

const writeRequest: WriteConsentRequest = {kind:'write',id:'write-1',conversationId:'default',runId:'run-1',controlVersion:0,expiresAt:Date.now()+60_000,goal:'填写方案并保存',description:'填写 方案',tool:'fill',target:'#choice',value:'远山'};

describe('consent card copy',()=>{
  it('keeps fetch requests phrased as a network send',()=>{
    expect(consentHeading(fetchRequest,true)).toBe('允许发送这次请求吗？');
    expect(consentTargetText(fetchRequest)).toBe('POST https://example.test/api');
    expect(consentDetailsText(fetchRequest)!.summary).toBe('查看发送内容');
    expect(consentDetailsText(fetchRequest)!.content).toContain('请求头');
    expect(consentStatusText(fetchRequest,true)).toContain('不会发送');
  });

  it('describes the write confirmation as one exact action, with task, object and autosave warning',()=>{
    expect(consentHeading(writeRequest,true)).toBe('允许核对并在需要时重设这一项吗？');
    expect(consentHeading(writeRequest,false)).toBe('请求确认');
    expect(consentTargetText(writeRequest)).toBe('任务：填写方案并保存');
    const details=consentDetailsText(writeRequest)!;
    expect(details.summary).toBe('查看动作');
    expect(details.content).toContain('未确认的动作：填写 方案');
    expect(details.content).toContain('只执行这一次：填写「远山」');
    expect(details.content).not.toMatch(/\bfill\b|#choice/);
    expect(details.content).toContain('若当前对象已经满足，不写入');
    expect(details.content).toContain('当前页面');
    expect(details.content).toContain('自动保存');
    expect(consentStatusText(writeRequest,true)).toContain('不会执行');
  });

  it('never claims permission while disconnected',()=>{
    expect(consentStatusText(writeRequest,false)).toContain('连接已断开');
    expect(consentStatusText(fetchRequest,false)).toContain('连接已断开');
  });
});

// 网页操作卡（10-04 用户：“为什么这么丑的东西也要放上去”）。失败方式先列：
// F1 内部字段（标签页编号、表单策略）原样出现；F2 有用的内容（填写的字、网址、脚本、按键）被藏掉；
// F3 参数解不开时什么都不显示；F4 读页面这种没有可看内容的卡仍有空折叠和“可能提交”的警告。
describe('activation card shows only what the user can check',()=>{
  type ActionParams={tabId?:number;target?:string;label?:string;value?:string;url?:string;code?:string;key?:string;mystery?:string;formRequirements?:[];userValueProvided?:boolean};

  const act=(tool:string,params:ActionParams,target='当前页面'):WriteConsentRequest=>({kind:'write',purpose:'activation',id:`a-${tool}`,conversationId:'default',runId:'run-1',controlVersion:0,expiresAt:Date.now()+60_000,goal:'g',description:tool,tool,target,value:JSON.stringify(params)});

  it('reading a page has no details at all',()=>{
    expect(consentDetailsText(act('snapshot',{tabId:1183412975}))).toBeNull();
    expect(consentTargetText(act('snapshot',{tabId:1183412975}))).toBe('操作：读取页面');
  });

  it('fill shows the text as plain content, without internal fields (F1/F2)',()=>{
    const details=consentDetailsText(act('fill',{target:'#note',value:'MCP 是一种协议\n来源：http://x.test/status/1',tabId:1183412984,formRequirements:[],userValueProvided:false},'#note'))!;
    expect(details.content).toContain('内容：MCP 是一种协议\n来源：http://x.test/status/1');
    expect(details.content).not.toMatch(/tabId|formRequirements|userValueProvided|1183412984|\{/);
    expect(details.content).toContain('自动保存');
  });

  it('click keeps the real target; the unverified label never replaces it',()=>{
    const request=act('click',{target:'#delete',label:'保存',tabId:1,formRequirements:[],userValueProvided:false},'#delete');
    expect(consentTargetText(request)).toBe('操作：点击 #delete');
    expect(consentDetailsText(request)).toBeNull();
  });

  it('script, key and unknown fields stay visible (F2)',()=>{
    expect(consentDetailsText(act('js',{tabId:1,code:'document.title'}))!.content).toContain('脚本：document.title');
    expect(consentDetailsText(act('press_key',{tabId:1,key:'Enter'}))!.content).toContain('按键：Enter');
    expect(consentDetailsText(act('new_tool',{tabId:1,mystery:'x'}))!.content).toContain('mystery：x');
  });

  it('opening a page shows the address in the target line only',()=>{
    const request=act('open_tab',{url:'https://zh.wikipedia.org/wiki/MCP'},'https://zh.wikipedia.org/wiki/MCP');
    expect(consentTargetText(request)).toBe('操作：打开标签页 https://zh.wikipedia.org/wiki/MCP');
    expect(consentDetailsText(request)).toBeNull();
  });

  it('unparseable parameters are shown as they are (F3)',()=>{
    expect(consentDetailsText(act('fill',{}))).toBeNull();
    expect(consentDetailsText({...act('fill',{}),value:'not json'})!.content).toContain('not json');
  });
});
