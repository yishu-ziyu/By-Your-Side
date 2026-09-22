export interface P0Case {id:string;task:string;fault:string;maxSideEffects:number;preserveRun:boolean}

export interface P0Manifest {version:number;cases:P0Case[]}

export interface P0Build {head:string;fingerprint:string;manifestHash:string}

export interface P0Report {
  version:1;
  kind:'p0-simulated-user';
  build:P0Build;
  environment:{isolated:boolean;headless:boolean;realModelUsed:boolean;model:string};
  cases:Array<{id:string;status:'NOT_RUN'|'PASS'|'FAIL'|'BLOCKED';startedAt:string|null;endedAt:string|null;
    beforeRunId:string|null;afterRunId:string|null;
    metrics:null|{expectedOutcome:boolean;sideEffects:number;duplicateWrites:number;wrongPageWrites:number;recoveryFailures:number;userCorrections:number};
    evidence:Array<{kind:'trace'|'state';path:string;sha256:string}>;notes:string}>;
}

export function emptyP0Report(manifest:P0Manifest,build:P0Build):P0Report {
  return {version:1,kind:'p0-simulated-user',build,environment:{isolated:true,headless:true,realModelUsed:false,model:''},
    cases:manifest.cases.map(item=>({id:item.id,status:'NOT_RUN',startedAt:null,endedAt:null,beforeRunId:null,afterRunId:null,metrics:null,evidence:[],notes:''}))};
}

/** This validates evidence completeness and declared metrics, not the truth of a browser transcript. */
export function validateP0Report(raw:unknown,manifest:P0Manifest,build:P0Build,checkEvidence:(path:string,hash:string)=>boolean){
  const errors:string[]=[];
  const record=raw as P0Report|null;

  if(!record||record.version!==1||record.kind!=='p0-simulated-user'||!Array.isArray(record.cases))return {status:'FAIL',errors:['无效的 P0 结果格式。'],passed:0,total:manifest.cases.length};

  if(!record.build||Object.keys(build).some(key=>record.build[key as keyof P0Build]!==build[key as keyof P0Build]))errors.push('代码或场景清单已变化；不能用旧构建的结果验收当前工作树。');
  const ids=record.cases.map(item=>item?.id);

  if(new Set(ids).size!==ids.length||ids.length!==manifest.cases.length||manifest.cases.some(item=>!ids.includes(item.id)))errors.push('场景有缺失、重复或未知编号，不能跳过必测项。');
  const passing=record.cases.filter(item=>item?.status==='PASS');

  if(passing.length&&(!record.environment?.isolated||!record.environment.headless||!record.environment.realModelUsed||typeof record.environment.model!=='string'||!record.environment.model.trim()))errors.push('缺少隔离环境、无头运行或真实模型的记录。');
  const natural=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

  for(const item of record.cases){
    const expected=manifest.cases.find(candidate=>candidate.id===item?.id);

    if(!expected){errors.push('未知场景。');continue;}

    if(!['NOT_RUN','PASS','FAIL','BLOCKED'].includes(item.status)){errors.push(`${item.id}: 无效状态。`);continue;}

    if(item.status!=='PASS')continue;
    const metrics=item.metrics;

    if(!metrics||metrics.expectedOutcome!==true||!natural(metrics.sideEffects)||metrics.sideEffects>expected.maxSideEffects
      ||metrics.duplicateWrites!==0||metrics.wrongPageWrites!==0||metrics.recoveryFailures!==0||!natural(metrics.userCorrections))errors.push(`${item.id}: 未达到结果、重复写入或恢复门槛。`);

    if(!item.startedAt||!item.endedAt||!Number.isFinite(Date.parse(item.startedAt))||!Number.isFinite(Date.parse(item.endedAt))||Date.parse(item.endedAt)<Date.parse(item.startedAt))errors.push(`${item.id}: 缺少有效的起止时间。`);

    if(typeof item.afterRunId!=='string'||!item.afterRunId||expected.preserveRun&&(!item.beforeRunId||item.beforeRunId!==item.afterRunId))errors.push(`${item.id}: 缺少任务身份，或恢复时创建了新任务。`);

    if(!Array.isArray(item.evidence)||!['trace','state'].every(kind=>item.evidence.some(e=>e?.kind===kind))){errors.push(`${item.id}: 需要过程轨迹与页面/服务端状态两类原始证据。`);continue;}

    for(const evidence of item.evidence){
      if(!evidence||!['trace','state'].includes(evidence.kind)||typeof evidence.path!=='string'||typeof evidence.sha256!=='string'||!/^[a-f0-9]{64}$/.test(evidence.sha256)||!checkEvidence(evidence.path,evidence.sha256))errors.push(`${item.id}: 证据不存在、越界或校验和不符。`);
    }
  }

  const status=errors.length||record.cases.some(item=>item?.status==='FAIL')?'FAIL'
    :record.cases.some(item=>item?.status==='NOT_RUN')?'NOT_RUN'
    :record.cases.some(item=>item?.status==='BLOCKED')?'BLOCKED':'PASS';

  return {status,errors,passed:passing.length,total:manifest.cases.length};
}
