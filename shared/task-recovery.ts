export const TASK_CHECKPOINT_UNAVAILABLE = '原任务无法接着做，本会话已中止；原来的记录还在。不要重新提交可能做过的操作；新任务请另开一个会话。';

export interface TaskMaterialReference {
  key: string;
  kind: 'page' | 'selection' | 'attachment';
  label: string;
}

export const TASK_MATERIAL_MAX = 144;

export function isTaskMaterials(value: unknown): value is TaskMaterialReference[] {
  return Array.isArray(value) && value.length <= TASK_MATERIAL_MAX && value.every(item =>
    !!item && typeof item === 'object'
    && typeof item.key === 'string' && item.key.length > 0 && item.key.length <= 200
    && ['page', 'selection', 'attachment'].includes(item.kind)
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 160)
    && new Set(value.map(item => item.key)).size === value.length;
}

export interface TaskRecoveryInput {
  requirements:string[];
  page?:{tabId:number;urlHash:string};
  attachmentKeys:string[];
  materials?: TaskMaterialReference[];
}

export const RECOVERY_INPUT_MAX=64_000;

export function isTaskRecoveryInput(value:unknown):value is TaskRecoveryInput {
  if(!value||typeof value!=='object')return false;
  const input=value as TaskRecoveryInput;
  const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

  return Array.isArray(input.requirements)&&input.requirements.length<=64
    &&input.requirements.every(text=>typeof text==='string'&&text.length<=12000)
    &&input.requirements.reduce((size,text)=>size+text.length,0)<=RECOVERY_INPUT_MAX
    &&(input.page===undefined||!!input.page&&Number.isSafeInteger(input.page.tabId)&&input.page.tabId>0&&hash(input.page.urlHash))
    &&Array.isArray(input.attachmentKeys)&&input.attachmentKeys.length<=16&&input.attachmentKeys.every(hash)
    &&(input.materials===undefined||isTaskMaterials(input.materials));
}
