import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "conversation-A::writer";

async function loadReadElement(options: {
  ax?: boolean;
  refKind?: "ax" | "dom";
  resolveError?: string;
  sendCommand?: (tabId: number, method: string, params?: object) => Promise<unknown>;
} = {}) {
  vi.resetModules();

  const resolveWorkingTab = options.resolveError
    ? vi.fn(async () => { throw new Error(options.resolveError); })
    : vi.fn(async (tabId: number) => ({ id: tabId }));

  vi.doMock("../src/background/state.js", () => ({
    getWorkingTabId: vi.fn(async () => 12),
    resolveReadableTab: resolveWorkingTab,
  }));
  vi.doMock("../src/background/axstate.js", () => ({
    isAxRef: () => options.ax === true,
    snapshotRefKind: () => options.refKind ?? (options.ax === true ? "ax" : "dom"),
  }));
  vi.doMock("../src/background/debugger.js", () => ({ sendCommand: vi.fn(options.sendCommand ?? (async () => ({}))) }));

  return import("../src/background/exec/read-element.js");
}

function installScriptExecution() {
  const executeScript = vi.fn(async (details: any) => [{ result: details.func(...details.args) }]);
  vi.stubGlobal("chrome", { scripting: { executeScript } });

  return executeScript;
}

afterEach(() => {
  vi.doUnmock("../src/background/state.js");
  vi.doUnmock("../src/background/axstate.js");
  vi.doUnmock("../src/background/debugger.js");
  vi.unstubAllGlobals();
});

describe("read_element", () => {
  it('reads rich editor line boundaries without changing raw textContent or collapsing blank lines', async () => {
    const text=(value:string):any=>({nodeType:3,nodeName:'#text',textContent:value});
    const element=(tag:string,children:any[]=[],trailing=false):any=>({nodeType:1,nodeName:tag,tagName:tag,childNodes:children,textContent:children.map(c=>c.textContent).join(''),classList:{contains:(name:string)=>trailing&&name==='ProseMirror-trailingBreak'}});

    const cases:Array<[any[],string]>=[
      [[element('P',[text('First.')]),element('P',[text('https://source.test/')])],'First.\nhttps://source.test/'],
      [[text('First.\nhttps://source.test/')],'First.\nhttps://source.test/'],
      [[element('P',[text('First.'),element('BR'),text('URL')])],'First.\nURL'],
      [[element('P',[text('First.'),element('SPAN',[element('BR')]),text('URL')])],'First.\nURL'],
      [[element('P',[text('First.')]),element('P',[element('BR')]),element('P',[text('URL')])],'First.\n\nURL'],
      [[element('P',[text('First.')]),element('P',[element('BR')])],'First.\n'],
      [[element('P',[text('First.'),element('BR'),element('BR',[],true)])],'First.\n'],
      [[element('P',[text('First '),element('STRONG',[text('sentence.')])])],'First sentence.'],
    ];

    let editor:any;
    vi.stubGlobal('document',{querySelectorAll:()=>[editor]});
    installScriptExecution();
    const {readElement}=await loadReadElement();

    for(const [children,expected] of cases){
      editor={...element('DIV',children),isContentEditable:true,isConnected:true};
      const result=await readElement({target:'#editor'},KEY);
      expect(result.editableText).toBe(expected);
      expect(result.textContent).toBe(editor.textContent);
    }
  });

  it("逐字返回200+文本和60+字段value，且不触发页面状态", async () => {
    const textContent = "材料".repeat(130);
    const value = "完整字段值".repeat(20);
    const element = { tagName: "TEXTAREA", textContent, value, isConnected: true };
    const activeElement = { id: "before" };
    const documentState = { querySelectorAll: vi.fn(() => [element]), activeElement };
    vi.stubGlobal("document", documentState);
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement();

    const result = await readElement({ target: "#material" }, KEY);
    expect(result).toEqual({ tabId: 12, target: "loc=css:#material", tagName: "textarea", textContent, value });
    expect(result.textContent).toHaveLength(textContent.length);
    expect(result.value).toHaveLength(value.length);
    expect(documentState.activeElement).toBe(activeElement);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("支持当前DOM snapshot ref，过期ref明确失败", async () => {
    const element = { tagName: "DIV", textContent: "完整正文", isConnected: true };
    vi.stubGlobal("window", { __sideagent: { refs: new Map([[7, element]]) } });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ tabId: 12, target: "@7" }, KEY)).resolves.toMatchObject({ target: "@7", textContent: "完整正文" });
    await expect(readElement({ tabId: 12, target: "@8" }, KEY)).rejects.toThrow(/ref @8 已过期/);
  });

  it("最新快照为AX时不回落读取旧DOM ref", async () => {
    const element = { tagName: "DIV", textContent: "旧材料", isConnected: true };
    vi.stubGlobal("window", { __sideagent: { refs: new Map([[7, element]]) } });
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement({ refKind: "ax" });
    await expect(readElement({ tabId: 12, target: "@7" }, KEY)).rejects.toThrow(/不属于当前 snapshot/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("CSS missing、多匹配和非法selector明确失败", async () => {
    const querySelectorAll = vi.fn((selector: string) => {
      if (selector === "#missing") return [];

      if (selector === ".many") return [{}, {}];
      throw new Error("invalid selector");
    });

    vi.stubGlobal("document", { querySelectorAll });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: "#missing" }, KEY)).rejects.toThrow(/未找到目标元素/);
    await expect(readElement({ target: ".many" }, KEY)).rejects.toThrow(/匹配 2 个元素/);
    await expect(readElement({ target: "[" }, KEY)).rejects.toThrow(/无效的 CSS/);
  });

  it("外会话、未共享或关闭页错误不回退到活动页", async () => {
    const executeScript = installScriptExecution();
    const { readElement } = await loadReadElement({ resolveError: "标签页属于其他会话或未向当前成员共享" });
    await expect(readElement({ tabId: 99, target: "#secret" }, KEY)).rejects.toThrow(/属于其他会话/);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("当前AX ref通过固定callFunctionOn读取，不使用Runtime.evaluate", async () => {
    const calls: string[] = [];
    const textContent = "长正文".repeat(80);
    const value = "长值".repeat(40);

    const { readElement } = await loadReadElement({
      ax: true,
      sendCommand: async (_tabId, method) => {
        calls.push(method);

        if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } };

        return { result: { value: { ok: true, data: { tagName: "textarea", textContent, value } } } };
      },
    });

    vi.stubGlobal("chrome", { scripting: { executeScript: vi.fn() } });
    const result = await readElement({ tabId: 12, target: "@42" }, KEY);
    expect(result).toMatchObject({ textContent, value });
    expect(calls).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
    expect(calls).not.toContain("Runtime.evaluate");
  });

  it("拒绝表达式式locator，超限时失败而不返回截断内容", async () => {
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: "loc=h3:has-text('x')" }, KEY)).rejects.toThrow(/只支持当前 @ref/);
    vi.stubGlobal("document", { querySelectorAll: () => [{ tagName: "DIV", textContent: "x".repeat(1_000_001), isConnected: true }] });
    await expect(readElement({ target: "#huge" }, KEY)).rejects.toThrow(/超过安全上限.*未返回部分内容/);
  });
});

describe('read_element state and bounded verification', () => {
  it('reads actual media state and waits in one read-only call for the requested state', async () => {
    let reads = 0;
    const media = { tagName: 'VIDEO', textContent: '', isConnected: true, get paused() { return ++reads >= 2; }, currentTime: 12 };
    vi.stubGlobal('document', { querySelectorAll: () => [media] });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    const result = await readElement({ target: 'video', properties: ['currentTime'], expect: { property: 'paused', equals: true }, timeoutMs: 200 } as any, KEY);
    expect(result).toMatchObject({ properties: { paused: true, currentTime: 12 }, check: { matched: true, property: 'paused' } });
    expect(reads).toBe(2);
  });
  it('does not confuse a successful read with a satisfied expectation', async () => {
    const media = { tagName: 'VIDEO', textContent: '', isConnected: true, paused: false };
    vi.stubGlobal('document', { querySelectorAll: () => [media] });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: 'video', expect: { property: 'paused', equals: true } } as any, KEY)).rejects.toThrow(/条件未满足/);
  });
  it('rejects unavailable state, unknown properties and ambiguous targets without polling a different object', async () => {
    const query = vi.fn(() => [{ tagName: 'DIV', textContent: 'ready', isConnected: true }]);
    vi.stubGlobal('document', { querySelectorAll: query });
    installScriptExecution();
    const { readElement } = await loadReadElement();
    await expect(readElement({ target: '#x', expect: { property: 'paused', equals: true }, timeoutMs: 200 } as any, KEY)).rejects.toThrow(/不支持.*paused/);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readElement({ target: '#x', expect: { property: 'paused', equals: 'true' }, timeoutMs: 200 } as any, KEY)).rejects.toThrow(/boolean.*不能加引号/);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readElement({ target: '#x', properties: ['arbitrary'] } as any, KEY)).rejects.toThrow(/属性/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

async function readbackPage(target='@4',ax=true) {
  const page={documentId:'original-document',value:'星河',type:'text',cancelled:false};
  const valueRead=vi.fn(()=>page.value);

  const element={tagName:'INPUT',nodeType:1,isConnected:true,textContent:'',parentElement:null,
    get type(){return page.type;},get value(){return valueRead();},
    getAttribute:(name:string)=>name==='type'?page.type:null,querySelector:()=>null,labels:[]};

  const refs=new Map([[4,element]]);
  const pageElements=[element];
  vi.stubGlobal('window',{__sideagent:{refs}});
  vi.stubGlobal('document',{readyState:'complete',querySelectorAll:()=>pageElements});
  vi.stubGlobal('location',{href:'https://same-url.test/'});

  const executeScript=vi.fn(async(details:any)=>{
    if(details.target.documentIds&&!details.target.documentIds.includes(page.documentId))throw Error('Document no longer exists');

    return [{documentId:page.documentId,result:details.func(...(details.args??[]))}];
  });

  vi.stubGlobal('chrome',{scripting:{executeScript}});

  const cdp=vi.fn(async(_tabId:number,method:string,params:any)=>{
    if(method==='DOM.resolveNode')return {object:{objectId:'original-node'}};

    if(method==='Runtime.callFunctionOn')return {result:{value:Function(`return (${params.functionDeclaration})`)().call(element)}};

    return {};
  });

  const {readElement}=await loadReadElement({ax,sendCommand:cdp});
  const before=await readElement({tabId:12,target},KEY);
  valueRead.mockClear();

  const read=()=>readElement({tabId:12,target:before.target,properties:['value'],readback:{documentId:before.documentId!,deadline:Date.now()+1500,nodeIdentity:before.nodeIdentity}},KEY,
    ()=>{if(page.cancelled)throw Error('READBACK_CANCELLED');});

  return {page,before,valueRead,executeScript,read,readElement,refs,pageElements,element,cdp};
}

describe('host-bound adjunct read document and cancellation gates',()=>{
  it('binds the actual pre-write document and only reads the current value once',async()=>{
    const f=await readbackPage();
    expect(f.before.documentId).toBe('original-document');
    expect(await f.read()).toMatchObject({tabId:12,documentId:f.before.documentId,target:'@4',value:'星河',properties:{value:'星河'},textContent:''});
    expect(f.valueRead).toHaveBeenCalledTimes(1);
    expect(f.before.nodeIdentity).toEqual({kind:'ax',backendNodeId:4});
    expect(f.cdp.mock.calls.filter(([,method])=>method==='Runtime.callFunctionOn')).toHaveLength(2);
  });
  it.each([
    ['#code','OTHER_RECORD_VALUE'], ['@4','OTHER_RECORD_VALUE'],
    ['#code','星河'], ['@4','星河'],
  ])('rejects replacement %s even with value %s before touching its getter',async(target,value)=>{
    const f=await readbackPage(target,false);
    f.element.isConnected=false;
    const replacementValue=vi.fn(()=>value);

    const replacement={...f.element,isConnected:true,get value(){return replacementValue();},
      getAttribute:(name:string)=>name==='name'?'record-B':name==='type'?'text':null};

    f.pageElements[0]=replacement;f.refs.set(4,replacement);
    f.valueRead.mockClear();
    await expect(f.read()).rejects.toThrow(/READBACK_/);
    expect(replacementValue).not.toHaveBeenCalled();
    expect(f.valueRead).not.toHaveBeenCalled();
  });
  it.each(['document','password','cancelled','detached'] as const)('does not read a field after %s changes',async change=>{
    const f=await readbackPage();

    if(change==='document')f.page.documentId='new-document-at-same-url';

    if(change==='password')f.page.type='password';

    if(change==='cancelled')f.page.cancelled=true;

    if(change==='detached')f.element.isConnected=false;
    await expect(f.read()).rejects.toThrow(/READBACK_/);
    expect(f.valueRead).not.toHaveBeenCalled();
  });
  it('expires during an awaited document check without dispatching a later field read',async()=>{
    vi.useFakeTimers();const f=await readbackPage();
    let finish!:()=>void;
    f.executeScript.mockImplementationOnce(async(details:any)=>{
      await new Promise<void>(resolve=>{finish=resolve;});

      return [{documentId:f.page.documentId,result:details.func()}];
    });

    try {
      const pending=f.read();const rejected=expect(pending).rejects.toThrow('READBACK_TIMEOUT');
      await vi.waitFor(()=>expect(finish).toBeDefined());
      await vi.advanceTimersByTimeAsync(1500);finish();await rejected;
      expect(f.valueRead).not.toHaveBeenCalled();
      expect(f.executeScript.mock.calls.filter(([call])=>call.target.documentIds)).toHaveLength(0);
    } finally {vi.useRealTimers();}
  });
  it('rejects a navigation during the result await instead of returning stale success',async()=>{
    const f=await readbackPage(),execute=f.cdp.getMockImplementation()!;
    f.cdp.mockImplementation(async(...args)=>{
      const result=await execute(...args);

      if(args[1]==='Runtime.callFunctionOn')f.page.documentId='replacement-after-read';

      return result;
    });
    await expect(f.read()).rejects.toThrow('READBACK_DOCUMENT_CHANGED');
    expect(f.valueRead).toHaveBeenCalledTimes(1);
  });
});
