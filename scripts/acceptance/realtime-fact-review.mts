/** Offline only: no live runner imports, sockets, browser, audio or model calls. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {assessFactRun,type FactEvent,type FactScenario} from './realtime-fact-oracle.mjs';

const root=resolve(process.argv[2]??'out/acceptance/realtime-fact-consumption-1790003676005');

const output=join(root,`independent-review-${Date.now()}.json`);

const hash=(path:string|URL)=>createHash('sha256').update(readFileSync(path)).digest('hex');

const originalAssessment=JSON.parse(readFileSync(join(root,'assessment.json'),'utf8'));

const protectedFiles=['assessment.json',...['A1','A2','B1','B2','C1','C2','D1','D2'].flatMap(id=>[`${id}/events.jsonl`,`${id}/result.json`])];

const before=Object.fromEntries(protectedFiles.map(file=>[file,hash(join(root,file))]));

const cases=['A1','A2','B1','B2','C1','C2','D1','D2'].map(id=>{
 const events:FactEvent[]=readFileSync(join(root,id,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const original=JSON.parse(readFileSync(join(root,id,'result.json'),'utf8'));
 const probe=events.filter(e=>e.channel==='independent-probe'&&e.data.phase==='after').at(-1)?.data.probe??null;
 const revised=assessFactRun(id[0] as FactScenario,events,probe);

 return {id,originalObservation:{result:original,assessment:originalAssessment.assessed.find((row:any)=>row.id===id)},
  revised,changes:{postActionRead:{original:original.postActionRead,revised:revised.postActionRead}},
  evidenceGaps:revised.readbackEvidence.filter(row=>row.observation==='UNDETERMINED'||row.delivered==='UNDETERMINED'),
  scenarioLimit:id==='B1'?'SOURCE_CONTAMINATED: held consumption UNDETERMINED':id.startsWith('D')?'INJECTION_NOT_TRIGGERED: read failure consumption UNDETERMINED':null};
});

const after=Object.fromEntries(protectedFiles.map(file=>[file,hash(join(root,file))]));

if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Original evidence changed while reviewing');

writeFileSync(output,JSON.stringify({revision:'independent-readback-review-v1',oracleSha256:hash(new URL('./realtime-fact-oracle.mts',import.meta.url)),humanAcceptance:'NOT_RUN',
 sourceVersionLimit:'Original eight runs did not use one fixed source version. Hashes detect changes only; they do not freeze runtime.',
 deliveryBoundary:'Recorded provider-out after socket.send returns, before response.create/response.created; not proof of model reasoning or server acknowledgement.',
 originalEvidenceHashes:before,originalEvidenceUnchanged:true,cases},null,2)+'\n',{flag:'wx'});

console.log(output);

for(const row of cases)console.log(row.id,JSON.stringify({old:row.changes.postActionRead.original,read:row.revised.postActionRead,delivered:row.revised.readEvidenceDelivered,matches:row.revised.readValueMatches,limit:row.scenarioLimit}));
