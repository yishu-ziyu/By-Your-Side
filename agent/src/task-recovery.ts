import {createHash} from 'node:crypto';
import type {Attachment, PageContext} from '../../shared/protocol.js';
import { TASK_MATERIAL_MAX, type TaskMaterialReference, type TaskRecoveryInput } from '../../shared/task-recovery.js';
import { sanitizeTrace } from '../../shared/trace-sanitize.js';
import { base64Bytes } from '../../shared/bytes.js';

/** 记录接收事实，UI 不靠本地缓存恢复材料；同一来源去重，不将不同页面的选区混合。 */
export function mergeTaskMaterials(prior: readonly TaskMaterialReference[], context?: PageContext, attachments?: Attachment[]): TaskMaterialReference[] {
  const materials = new Map(prior.map(item => [item.key, item]));

  const label = (text: string) => {
    const clean = String(sanitizeTrace(text)).trim();

    return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
  };

  const page = context && pageRecoveryKey(context.tabId, context.url);

  if (page && context) {
    const host = new URL(context.url).host;
    const key = `page:${page.tabId}:${page.urlHash}`;
    materials.set(key, { key, kind: 'page', label: label(`${context.title || '页面'}（${host}）`) });

    if (context.selection?.text.trim()) {
      const key = `selection:${createHash('sha256').update(page.urlHash).update(context.selection.text).digest('hex')}`;
      materials.set(key, { key, kind: 'selection', label: label(`「${context.selection.text}」`) });
    }
  }

  for (const attachment of attachments ?? []) {
    const key = `attachment:${attachmentRecoveryKey(attachment)}`;
    materials.set(key, { key, kind: 'attachment', label: label(attachment.name) || '附件' });
  }

  if (materials.size > TASK_MATERIAL_MAX) throw new Error('任务材料已达到保留上限，这条修改未接收；请先交付已有结果或另开任务。');

  return [...materials.values()];
}

/** Check equality without persisting query-string tokens or private URLs. */
export function pageRecoveryKey(tabId:number,url:string):NonNullable<TaskRecoveryInput['page']>|undefined {
  if(!Number.isSafeInteger(tabId)||tabId<=0||!url)return;

  try{
    const normalized=new URL(url);normalized.username='';normalized.password='';

    return {tabId,urlHash:createHash('sha256').update(normalized.href).digest('hex')};
  }catch{return;}
}

export function attachmentRecoveryKey(attachment:Attachment):string {
  return createHash('sha256').update(attachment.mimeType).update('\0').update(base64Bytes(attachment.dataBase64)).digest('hex');
}
