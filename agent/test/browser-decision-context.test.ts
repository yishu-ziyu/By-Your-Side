import {expect,it} from 'vitest';
import {browserContextChange} from '../../shared/browser-decision-context.js';
import {browserCandidates,type BrowserObservation} from '../../shared/browser-decision.js';
const page=():BrowserObservation=>({id:'a',documentId:'d',tabId:7,url:'https://test.invalid',observedAt:1,source:'accessibility',text:'page',truncated:false,controls:[
 {ref:'@1',role:'button',name:'Apply',disabled:false,scopeId:'form1',scopeLabel:'First form'},
 {ref:'@2',role:'textbox',name:'Value',value:'original',disabled:false,scopeId:'form1'},
 {ref:'@3',role:'button',name:'Counter 1',disabled:false,scopeId:'form2'}]});
it('an unrelated panel counter does not invalidate the target',()=>{const before=page(),after=page();after.controls[2]!.name='Counter 2';expect(browserContextChange(before,after,'@1')).toBeNull();});
it.each(['field','target','group','dialog','document','readonly','option'])('does reject changed relevant evidence: %s',change=>{
 const before=page(),after=page();
 if(change==='field')after.controls[1]!.value='human edit';
 if(change==='target')after.controls[0]!.name='Delete';
 if(change==='group')after.controls.push({ref:'@4',role:'checkbox',name:'Additional condition',disabled:false,scopeId:'form1'});
 if(change==='dialog')after.dialogs=['new dialog'];
 if(change==='document')after.documentId='other';
 if(change==='readonly')after.controls[1]!.readOnly=true;
 if(change==='option')after.controls[1]!.options=[{ref:'@5',label:'changed',disabled:false}];
 expect(browserContextChange(before,after,'@1')).not.toBeNull();
});
it('retains other-region field values as possible source dependencies',()=>{
 const before=page(),after=page();before.controls.push({ref:'@9',role:'textbox',name:'Source',value:'old',disabled:false,scopeId:'form2'});after.controls.push({ref:'@9',role:'textbox',name:'Source',value:'new',disabled:false,scopeId:'form2'});
 expect(browserContextChange(before,after,'@1')).not.toBeNull();
});
it('a short decision view must not false-stale against a full collected baseline',()=>{
 const full=page();
 full.controls.push(
  ...Array.from({length:200},(_,i)=>({ref:`@${100+i}`,role:'button' as const,name:`Extra ${i}`,disabled:false,scopeId:'form3',scopeLabel:'Other'})),
 );
 const view={...full,controls:full.controls.slice(0,3)};
 // Wrong: compare 3-item view to 203-item tree as if the missing items were deletions.
 expect(view.controls.length).toBe(3);
 expect(full.controls.length).toBeGreaterThan(100);
 // Right: verification uses the collected baseline, so same facts → no stale.
 expect(browserContextChange(full,{documentId:full.documentId,url:full.url,controls:full.controls},'@1')).toBeNull();
});
it('readonly and protected fields have no fill candidate',()=>{
 const p=page();p.controls[1]!.readOnly=true;expect(browserCandidates(p,[],true).some(c=>c.target==='@2')).toBe(false);
 p.controls[1]!.readOnly=false;p.controls[1]!.protected=true;expect(browserCandidates(p,[],true).some(c=>c.target==='@2')).toBe(false);
});
it('selects observed native option labels without a text-model call',()=>{
 const p=page();p.controls=[{ref:'@1',role:'combobox',name:'Level',value:'One',disabled:false,options:[{ref:'@2',label:'One',disabled:false},{ref:'@3',label:'Two',disabled:false},{ref:'@4',label:'Forbidden',disabled:true}]}];
 const candidates=browserCandidates(p,[]);expect(candidates.filter(c=>c.optionLabel).map(c=>c.optionLabel)).toEqual(['Two']);
});
it('hasMore views still expose click candidates for controls in the current window',()=>{
 const p=page();
 p.hasMore=true;p.collectionComplete=true;p.controlsTruncated=false;
 expect(browserCandidates(p,[]).some(c=>c.target==='@1'&&c.operation==='click')).toBe(true);
});
