export const TASK_CHECKPOINT_UNAVAILABLE = '原任务检查点无法恢复，本会话已停止执行；原记录未被覆盖。请先修复检查点，不要重新提交可能已执行的操作；其他独立任务可另开会话。';

/** 只保留已接受材料的身份与短摘要，不复制正文、图片或带参数的页面地址。 */
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

/** Durable inputs. Page contents and image bytes are not copied into progress snapshots. */
export interface TaskRecoveryInput {
  requirements:string[];
  page?:{tabId:number;urlHash:string};
  attachmentKeys:string[];
  /** 旧检查点缺省代表没有材料清单证据，不从页面哈希猜正文。 */
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
