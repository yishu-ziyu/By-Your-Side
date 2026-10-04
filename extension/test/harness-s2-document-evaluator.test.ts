import {beforeEach,afterEach,expect,it,vi} from 'vitest';

let doc:string|null='doc-old';

vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn(async()=>doc?{documentId:doc,url:'https://same-url.test',readyState:'complete'}:null)}));

beforeEach(()=>{vi.resetModules();doc='doc-old';});

afterEach(()=>vi.clearAllMocks());

const moduleUrl=new URL('../src/background/observation-document.ts',import.meta.url).href;

it('same-URL replacement invalidates the old member observation until it reobserves',async()=>{
 const m=await import(moduleUrl);await m.withObservedDocumentIdentity(7,'main',async()=>({text:'old X'}));doc='doc-new';await expect(m.assertObservedDocument(7,'main',['@1'])).rejects.toThrow(/snapshot|重新/);await m.withObservedDocumentIdentity(7,'main',async()=>({text:'new Y'}));await expect(m.assertObservedDocument(7,'main',['@1'])).resolves.toBe('doc-new');
});

it('a different member observation cannot refresh old main targets',async()=>{const m=await import(moduleUrl);await m.withObservedDocumentIdentity(7,'main',async()=>({}));doc='new';await m.withObservedDocumentIdentity(7,'worker',async()=>({}));await expect(m.assertObservedDocument(7,'main',['@1'])).rejects.toThrow();});

it('navigation during observation cannot publish a coherent old snapshot',async()=>{const m=await import(moduleUrl);await expect(m.withObservedDocumentIdentity(7,'main',async()=>{doc='replaced';

return {text:'old'};})).rejects.toThrow();});

it('lost document identity fails closed once an observation is known',async()=>{const m=await import(moduleUrl);await m.withObservedDocumentIdentity(7,'main',async()=>({}));doc=null;await expect(m.assertObservedDocument(7,'main',['@1'])).rejects.toThrow();});

it('document changes inside an operation are detected before final mutation',async()=>{const m=await import(moduleUrl);const initial=await m.assertObservedDocument(7,'main',['@1']);doc='new';await expect(m.assertSameDocument(7,initial)).rejects.toThrow();});

// 页面在 snapshot 之后刷新：只有旧快照的 @N 属于旧文档（docs/evals/20261004-script-friction.md R1）。
// 失败方式：CSS/xpath/text/坐标/无目标输入被一并拒绝；或反向过宽，旧 @N 在新文档上放行。
it('after a reload only an old @N ref is refused; selectors, coordinates and untargeted input pass',async()=>{
 const m=await import(moduleUrl);await m.withObservedDocumentIdentity(7,'main',async()=>({text:'old'}));doc='doc-new';

 for(const targets of [['#ack'],['loc=css:#ack'],['xpath=//button'],['text=已读'],[undefined],[]])await expect(m.assertObservedDocument(7,'main',targets)).resolves.toBe('doc-new');

 await expect(m.assertObservedDocument(7,'main',['@5'])).rejects.toThrow(/页面文档已变化/);
 await expect(m.assertObservedDocument(7,'main',['#ack','@5'])).rejects.toThrow(/页面文档已变化/);
});
