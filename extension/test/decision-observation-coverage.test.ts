import {describe,expect,it,vi} from 'vitest';

vi.mock('../src/background/debugger.js',()=>({sendCommand:vi.fn()}));

vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn()}));

import {decisionControls,decisionControlsTruncated,selectObservationView,VIEW_CONTROL_BUDGET,VIEW_TAB_BUDGET,MAX_COLLECTED_CONTROLS,SCOPE_SUMMARY_BUDGET,BrowserObservationRegistry} from '../src/background/browser-observation.js';
import {axTreeToText,type AxNodeLite} from '../src/background/axtree.js';
import {browserCandidates,isBrowserObservation} from '../../shared/browser-decision.js';
import {browserContextChange} from '../../shared/browser-decision-context.js';

/** Hand-written 240-control page: region A (80) + region B (160). Target is B's 20th button = overall index 99 (0-based 99) wait — target after 100. */
function page240(): {nodes: AxNodeLite[]; targetRef: string; targetIndex: number} {
  const nodes: AxNodeLite[] = [
    {nodeId:'root',role:{value:'RootWebArea'},childIds:['ra','rb'],backendDOMNodeId:1},
    {nodeId:'ra',parentId:'root',role:{value:'region'},name:{value:'Region A'},backendDOMNodeId:2,childIds:[]},
    {nodeId:'rb',parentId:'root',role:{value:'region'},name:{value:'Region B'},backendDOMNodeId:3,childIds:[]},
  ];

  const aKids: string[] = [];
  const bKids: string[] = [];
  let id = 10;

  for (let i = 0; i < 80; i++) {
    const n = `a${i}`;
    aKids.push(n);
    nodes.push({nodeId:n,parentId:'ra',role:{value:'button'},name:{value:`A-${i}`},backendDOMNodeId:id++});
  }

  let targetRef = '';
  let targetIndex = -1;

  for (let i = 0; i < 160; i++) {
    const n = `b${i}`;
    bKids.push(n);
    const backend = id++;
    nodes.push({nodeId:n,parentId:'rb',role:{value:'button'},name:{value:i === 40 ? 'Submit' : `B-${i}`},backendDOMNodeId:backend});

    // Overall control index: 80 + i; need > 99 (after first 100-view). Pick B-40 → index 120.
    if (i === 40) {
      targetRef = `@${backend}`;
      targetIndex = 80 + i;
    }
  }

  (nodes[1] as AxNodeLite).childIds = aKids;
  (nodes[2] as AxNodeLite).childIds = bKids;
  expect(targetIndex).toBeGreaterThan(99);

  return {nodes,targetRef,targetIndex};
}

describe('SEL-01 collection vs view coverage',()=>{
  it('old 240-control truncating view would drop the late-region target; full collection keeps it reachable via continue',()=>{
    const {nodes,targetRef,targetIndex} = page240();
    const collected = decisionControls(nodes);
    expect(collected.length).toBe(240);
    expect(collected[targetIndex]!.ref).toBe(targetRef);
    expect(collected[targetIndex]!.name).toBe('Submit');
    expect(collected[targetIndex]!.scopeLabel).toContain('Region B');

    // Hand-written oracle for the old bug: first-100 slice loses target.
    const oldView = collected.slice(0,100);
    expect(oldView.some(c => c.ref === targetRef)).toBe(false);
    expect(oldView.length).toBe(100);

    const first = selectObservationView({
      collected,
      tabs: [],
      collectionComplete: true,
      generation: 'gen-1',
      textTruncated: false,
    });

    expect(first.controls.length).toBeLessThanOrEqual(VIEW_CONTROL_BUDGET);
    expect(first.controls.some(c => c.ref === targetRef)).toBe(false);
    expect(first.hasMore).toBe(true);
    expect(first.collectionComplete).toBe(true);
    expect(first.controlsTruncated).toBe(false);
    expect(typeof first.nextCursor).toBe('string');

    const cont = selectObservationView({
      collected,
      tabs: [],
      collectionComplete: true,
      generation: 'gen-1',
      textTruncated: false,
      cursor: first.nextCursor,
    });

    expect(cont.controls.some(c => c.ref === targetRef)).toBe(true);
    expect(cont.controls.find(c => c.ref === targetRef)?.scopeLabel).toContain('Region B');
    // Other region must not silently replace the target action set for this view's Submit.
    expect(cont.controls.filter(c => c.name === 'Submit')).toHaveLength(1);
    expect(browserCandidates({
      id:'v',tabId:7,documentId:'d',url:'https://t.invalid',observedAt:1,source:'accessibility',text:'',truncated:false,
      controls:cont.controls,controlsTruncated:cont.controlsTruncated,collectionComplete:cont.collectionComplete,hasMore:cont.hasMore,
    },[]).some(c => c.target === targetRef && c.operation === 'click')).toBe(true);
  });

  it('24K text budget truncation does not delete already-collected controls; textTruncated stays accurate',()=>{
    // Enough long-named buttons that text budget must drop interactive refs; collection must keep all.
    const nodes: AxNodeLite[] = [{nodeId:'root',role:{value:'RootWebArea'},childIds:[],backendDOMNodeId:1}];
    const kids: string[] = [];

    for (let i = 0; i < 800; i++) {
      const id = `b${i}`;
      kids.push(id);
      nodes.push({nodeId:id,parentId:'root',role:{value:'button'},name:{value:`Late-${i}-${'长标签'.repeat(40)}`},backendDOMNodeId:5000+i});
    }

    (nodes[0] as AxNodeLite).childIds = kids;
    const text = axTreeToText(nodes);
    expect(text.truncated).toBe(true);
    const collected = decisionControls(nodes);
    expect(collected.length).toBe(800);
    const coupled = decisionControls(nodes, text.backendIds);
    expect(coupled.length).toBeLessThan(collected.length);
    expect(decisionControlsTruncated(nodes, collected)).toBe(false);
    const view = selectObservationView({collected:collected.slice(0,VIEW_CONTROL_BUDGET),tabs:[],collectionComplete:true,generation:'g',textTruncated:text.truncated});
    // Full collection would be passed in production; here we only assert text flag independence.
    expect(view.textTruncated).toBe(true);
    expect(view.controlsTruncated).toBe(false);
    expect(selectObservationView({collected,tabs:[],collectionComplete:true,generation:'g2',textTruncated:text.truncated}).collectedCount).toBe(800);
  });

  it('same-named buttons stay in their scopes; unrelated counter is not stale; source field change is',()=>{
    const beforeControls = decisionControls([
      {nodeId:'f1',role:{value:'form'},name:{value:'Left'},backendDOMNodeId:10},
      {nodeId:'f2',role:{value:'form'},name:{value:'Right'},backendDOMNodeId:20},
      {nodeId:'b1',parentId:'f1',role:{value:'button'},name:{value:'Save'},backendDOMNodeId:11},
      {nodeId:'t1',parentId:'f1',role:{value:'textbox'},name:{value:'Title'},value:{value:'draft'},backendDOMNodeId:12},
      {nodeId:'b2',parentId:'f2',role:{value:'button'},name:{value:'Save'},backendDOMNodeId:21},
      {nodeId:'c2',parentId:'f2',role:{value:'button'},name:{value:'Count 1'},backendDOMNodeId:22},
      {nodeId:'src',parentId:'f2',role:{value:'textbox'},name:{value:'Source'},value:{value:'old'},backendDOMNodeId:23},
    ]);

    const leftSave = beforeControls.find(c => c.ref === '@11')!;
    const rightSave = beforeControls.find(c => c.ref === '@21')!;
    expect(leftSave.scopeLabel).toContain('Left');
    expect(rightSave.scopeLabel).toContain('Right');
    expect(leftSave.scopeId).not.toBe(rightSave.scopeId);

    const afterCounter = beforeControls.map(c => c.ref === '@22' ? {...c,name:'Count 2'} : {...c});
    expect(browserContextChange(
      {id:'a',documentId:'d',tabId:7,url:'https://t.invalid',observedAt:1,source:'accessibility',text:'',truncated:false,controls:beforeControls},
      {documentId:'d',url:'https://t.invalid',controls:afterCounter},
      '@11',
    )).toBeNull();

    const afterSource = beforeControls.map(c => c.ref === '@23' ? {...c,value:'new'} : {...c});
    expect(browserContextChange(
      {id:'a',documentId:'d',tabId:7,url:'https://t.invalid',observedAt:1,source:'accessibility',text:'',truncated:false,controls:beforeControls},
      {documentId:'d',url:'https://t.invalid',controls:afterSource},
      '@11',
    )).not.toBeNull();
  });

  it('tabs and unscoped long lists and oversized scope summaries all expose real continue cursors',()=>{
    const list = Array.from({length:250},(_,i)=>({ref:`@${i+1}`,role:'button',name:`Item ${i}`,disabled:false}));
    const page = selectObservationView({collected:list,tabs:[],collectionComplete:true,generation:'gen-list',textTruncated:false});
    expect(page.controls.length).toBe(VIEW_CONTROL_BUDGET);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toMatch(/^gen-list:/);
    const page2 = selectObservationView({collected:list,tabs:[],collectionComplete:true,generation:'gen-list',textTruncated:false,cursor:page.nextCursor});
    expect(page2.controls[0]!.ref).toBe(`@${VIEW_CONTROL_BUDGET+1}`);
    expect(page2.controls.some(c => c.ref === `@${VIEW_CONTROL_BUDGET+1}`)).toBe(true);
    expect(page2.hasMore).toBe(true);
    const page3 = selectObservationView({collected:list,tabs:[],collectionComplete:true,generation:'gen-list',textTruncated:false,cursor:page2.nextCursor});
    expect(page3.controls.some(c => c.ref === '@240')).toBe(true);

    const manyTabs = Array.from({length:90},(_,i)=>({id:i+1,title:`T${i}`,url:`https://t.invalid/${i}`,active:false,windowId:1,working:false}));
    const tabsView = selectObservationView({collected:[{ref:'@1',role:'button',name:'Only',disabled:false}],tabs:manyTabs,collectionComplete:true,generation:'gen-tabs',textTruncated:false});
    expect(tabsView.tabs!.length).toBe(VIEW_TAB_BUDGET);
    expect(tabsView.tabsHasMore).toBe(true);
    expect(typeof tabsView.tabsNextCursor).toBe('string');
    const tabs2 = selectObservationView({collected:[{ref:'@1',role:'button',name:'Only',disabled:false}],tabs:manyTabs,collectionComplete:true,generation:'gen-tabs',textTruncated:false,cursor:tabsView.tabsNextCursor});
    expect(tabs2.tabs![0]!.id).toBe(VIEW_TAB_BUDGET+1);
    expect(tabs2.tabs!.some(t => t.id === 90)).toBe(true);

    // Many tiny scopes → summary itself paginates; must not dump all summaries.
    const scopes = Array.from({length:SCOPE_SUMMARY_BUDGET+20},(_,s)=>
      Array.from({length:3},(_,i)=>({ref:`@${s*3+i+1}`,role:'button',name:`S${s}-${i}`,disabled:false,scopeId:`scope-${s}`,scopeLabel:`Region ${s}`})),
    ).flat();

    const scoped = selectObservationView({collected:scopes,tabs:[],collectionComplete:true,generation:'gen-scopes',textTruncated:false});
    expect(scoped.scopes!.length).toBeLessThanOrEqual(SCOPE_SUMMARY_BUDGET);
    expect(scoped.scopesTruncated).toBe(true);
    expect(scoped.scopesHasMore).toBe(true);
    expect(typeof scoped.scopesNextCursor).toBe('string');
    const moreScopes = selectObservationView({collected:scopes,tabs:[],collectionComplete:true,generation:'gen-scopes',textTruncated:false,cursor:scoped.scopesNextCursor});
    expect(moreScopes.scopes![0]!.id).not.toBe(scoped.scopes![0]!.id);
  });

  it('resource budget and incomplete collection are reported; silent drop is forbidden',()=>{
    const over = Array.from({length:MAX_COLLECTED_CONTROLS+40},(_,i)=>({ref:`@${i+1}`,role:'button',name:`X${i}`,disabled:false}));
    const limited = over.slice(0,MAX_COLLECTED_CONTROLS);

    const view = selectObservationView({
      collected:limited,
      tabs:[],
      collectionComplete:false,
      collectionLimitReached:true,
      generation:'gen-budget',
      textTruncated:false,
    });

    expect(view.collectionComplete).toBe(false);
    expect(view.collectionLimitReached).toBe(true);
    expect(view.collectedCount).toBe(MAX_COLLECTED_CONTROLS);
    expect(view.controlsTruncated).toBe(true);
    // Still expose the collected window — not an empty "target missing" signal.
    expect(view.controls.length).toBeGreaterThan(0);
    expect(view.controls.length).toBeLessThanOrEqual(VIEW_CONTROL_BUDGET);
  });

  it('registry keeps collected baseline for verify while view stays bounded; continue-read shares generation and invalidates old guard',()=>{
    const collected = Array.from({length:240},(_,i)=>({ref:`@${i+1}`,role:'button',name:`N${i}`,disabled:false,scopeId:i<100?'s1':'s2',scopeLabel:i<100?'One':'Two'}));
    const r = new BrowserObservationRegistry();

    const first = r.issue('m',{
      tabId:7,documentId:'d1',url:'https://t.invalid',source:'accessibility',text:'page',truncated:false,
      controls:collected.slice(0,100),controlsTruncated:false,collectionComplete:true,collectedCount:240,
      hasMore:true,nextCursor:'gen-x:controls:100',generation:'gen-x',visibleCount:100,viewComplete:true,
    },{collectedControls:collected,generation:'gen-x'});

    expect(first.controls.length).toBe(100);
    expect(isBrowserObservation(first)).toBe(true);
    const stored = r.peekCollected('m',7);
    expect(stored?.length).toBe(240);
    const active = r.readActive('m',7);
    expect(active?.generation).toBe('gen-x');
    expect(active?.collected.length).toBe(240);
    // Verify path must use collected, not 100-vs-240 length trap.
    expect(browserContextChange(
      {...first,controls:stored!},
      {documentId:'d1',url:'https://t.invalid',controls:collected},
      '@150',
    )).toBeNull();

    const contView = selectObservationView({
      collected: active!.collected,
      tabs: [],
      collectionComplete: true,
      generation: active!.generation,
      textTruncated: false,
      cursor: 'gen-x:controls:s2:0',
    });

    expect(contView.generation).toBe('gen-x');
    expect(contView.controls.some(c => c.ref === '@150')).toBe(true);

    const cont = r.issue('m',{
      tabId:7,documentId:'d1',url:'https://t.invalid',source:'accessibility',text:'page',truncated:false,
      controls:contView.controls,controlsTruncated:false,collectionComplete:true,collectedCount:240,
      generation:'gen-x',visibleCount:contView.visibleCount,viewComplete:contView.viewComplete,hasMore:contView.hasMore,
    },{collectedControls:collected,generation:'gen-x'});

    expect(cont.id).not.toBe(first.id);
    expect(cont.generation).toBe('gen-x');
    expect(()=>r.consume('m',7,'click',{target:'@50',decisionGuard:{observationId:first.id,operation:'click',target:'@50'}})).toThrow('DECISION_STALE');
    expect(r.consume('m',7,'click',{target:'@150',decisionGuard:{observationId:cont.id,operation:'click',target:'@150'}}).controls.some(c=>c.ref==='@150')).toBe(true);
  });

  it('expired or foreign cursor fails closed without falling back to a viewport identity bypass',()=>{
    const collected = Array.from({length:150},(_,i)=>({ref:`@${i+1}`,role:'button',name:`N${i}`,disabled:false}));
    expect(()=>selectObservationView({
      collected,tabs:[],collectionComplete:true,generation:'gen-a',textTruncated:false,cursor:'gen-b:controls:100',
    })).toThrow(/CURSOR/);
    expect(()=>selectObservationView({
      collected,tabs:[],collectionComplete:true,generation:'gen-a',textTruncated:false,cursor:'gen-a:controls:9999',
    })).toThrow(/CURSOR/);
  });
});
