import {beforeEach,afterEach,expect,it,vi} from 'vitest';
let doc:string|null='doc-old';
vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn(async()=>doc?{documentId:doc,url:'https://same-url.test',readyState:'complete'}:null)}));
beforeEach(()=>{vi.resetModules();doc='doc-old';});afterEach(()=>vi.clearAllMocks());
const moduleUrl=new URL('../src/background/observation-document.ts',import.meta.url).href;
it('same-URL replacement invalidates the old member observation until it reobserves',async()=>{
 const m=await import(moduleUrl);await m.withObservedDocument(7,'main',async()=>({text:'old X'}));doc='doc-new';await expect(m.assertObservedDocument(7,'main')).rejects.toThrow(/snapshot|重新/);await m.withObservedDocument(7,'main',async()=>({text:'new Y'}));await expect(m.assertObservedDocument(7,'main')).resolves.toBe('doc-new');
});
it('a different member observation cannot refresh old main targets',async()=>{const m=await import(moduleUrl);await m.withObservedDocument(7,'main',async()=>({}));doc='new';await m.withObservedDocument(7,'worker',async()=>({}));await expect(m.assertObservedDocument(7,'main')).rejects.toThrow();});
it('navigation during observation cannot publish a coherent old snapshot',async()=>{const m=await import(moduleUrl);await expect(m.withObservedDocument(7,'main',async()=>{doc='replaced';return {text:'old'};})).rejects.toThrow();});
it('lost document identity fails closed once an observation is known',async()=>{const m=await import(moduleUrl);await m.withObservedDocument(7,'main',async()=>({}));doc=null;await expect(m.assertObservedDocument(7,'main')).rejects.toThrow();});
it('document changes inside an operation are detected before final mutation',async()=>{const m=await import(moduleUrl);const initial=await m.assertObservedDocument(7,'main');doc='new';await expect(m.assertSameDocument(7,initial)).rejects.toThrow();});
