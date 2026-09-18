import {createHash} from 'node:crypto';
import type {Attachment} from '../../shared/protocol.js';
import type {TaskRecoveryInput} from '../../shared/task-recovery.js';

/** Check equality without persisting query-string tokens or private URLs. */
export function pageRecoveryKey(tabId:number,url:string):NonNullable<TaskRecoveryInput['page']>|undefined {
  if(!Number.isSafeInteger(tabId)||tabId<=0||!url)return;
  try{
    const normalized=new URL(url);normalized.username='';normalized.password='';
    return {tabId,urlHash:createHash('sha256').update(normalized.href).digest('hex')};
  }catch{return;}
}
export function attachmentRecoveryKey(attachment:Attachment):string {
  return createHash('sha256').update(attachment.mimeType).update('\0').update(Buffer.from(attachment.dataBase64,'base64')).digest('hex');
}
