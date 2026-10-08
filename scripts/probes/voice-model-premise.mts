/** 只检查真实模型的请求参数；不是语音产品验收，不刷新令牌。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadModelPlan } from '../acceptance/real-path/inproc-config.mts';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { thinkingProfile, withMeasuredCapability } from '../../shared/model-capabilities.ts';
const plan = await loadModelPlan('openai-codex/gpt-6-luna');
const credentials = new InMemoryCredentialStore(), port = builtinModels({credentials});
const provider = port.getProvider(plan.providerId)!;
if(provider.auth.oauth)port.setProvider({...provider,auth:{...provider.auth,oauth:{...provider.auth.oauth,refresh:async()=>{throw Error('Probe never refreshes tokens');}}}});
await credentials.modify(plan.providerId, async () => plan.credential as never);
const model = withMeasuredCapability(port.getModel(plan.providerId,plan.modelId)!);
const out = join('out/acceptance/session-recovery',`${new Date().toISOString().replace(/[:.]/g,'-')}-voice-model-premise`);
await mkdir(out,{recursive:true});
const rows: unknown[] = [];
for(const arm of [{effort:'off'},{effort:'low'},{effort:'off',temperature:0}] as const) {
  const effort = arm.effort;
  const start = Date.now();
  try {
    const reply = await port.completeSimple(model,{messages:[{role:'user',content:'Reply OK only.',timestamp:Date.now()}]}, {transport:'sse',reasoning:effort==='off'?undefined:effort,...('temperature' in arm ? {temperature:arm.temperature} : {}),maxTokens:256,maxRetries:0,timeoutMs:20000,signal:AbortSignal.timeout(20000)});
    rows.push({...arm,elapsedMs:Date.now()-start,stopReason:reply.stopReason,errorMessage:reply.errorMessage,text:reply.content.filter(p=>p.type==='text').map(p=>p.text).join('')});
  } catch(e) { rows.push({effort,elapsedMs:Date.now()-start,error:String(e)}); }
}
await writeFile(join(out,'result.json'),JSON.stringify({profile:thinkingProfile(model),rows},null,2));
console.log(JSON.stringify({out,rows}));
