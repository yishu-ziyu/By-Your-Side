// Research-only: exercise current production state bookkeeping. No browser/network.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {TaskResultBook} from '../../../agent/src/task-results.ts';
const book=new TaskResultBook(()=>1);
book.register([
 {id:'observe',description:'观察播放器',tool:'snapshot',target:null},
 {id:'pause',description:'视频暂停',tool:'click',target:'@pause'},
 {id:'verify',description:'确认视频暂停',tool:'snapshot',target:null},
]);
function call(id:string,name:string,target:string|null){
 const event={toolCallId:id,name,target,member:'main',runId:'research'};
 book.noteStart(event);book.noteEnd({...event,failed:false});
}
call('read-1','snapshot',null);
call('pause-via-script','js',null);
const afterAlternative=book.list();
assert.equal(afterAlternative.find(x=>x.id==='pause')?.status,'pending');
call('read-2','snapshot',null);
const final=book.list();
assert.equal(final.find(x=>x.id==='verify')?.status,'satisfied');
assert.equal(book.state(),'pending');
const result={scope:'Current TaskResultBook only; no live browser, no claim of actual paused state',alternativeToolLeavesPending:true,successfulSnapshotAloneSatisfiesNamedVerification:true,state:book.state(),results:final};
writeFileSync(new URL('./bookkeeping-probe.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
