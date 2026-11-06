import { isTaskRecord, type TaskRecord } from '../../shared/task-record.js';
import { InProcessLock, type DocumentPersistence } from './document-persistence.js';

function recordsFrom(raw: string): TaskRecord[] {
  const file: unknown = JSON.parse(raw);

  if (!file || typeof file !== 'object' || Array.isArray(file)
    || Object.keys(file).some(key => key !== 'format' && key !== 'tasks')
    || !('format' in file) || file.format !== 1
    || !('tasks' in file) || !Array.isArray(file.tasks)
    || !file.tasks.every(isTaskRecord)
    || new Set(file.tasks.map(task => task.id)).size !== file.tasks.length) {
    throw new Error('任务记录无法读取，原记录已保留；未接收新改动。');
  }

  return file.tasks;
}

export class TaskRecordStore {
  private readonly lock = new InProcessLock();
  private records: TaskRecord[] = [];

  constructor(private readonly doc?: DocumentPersistence) {}

  async list(origin?: string): Promise<TaskRecord[]> {
    return this.exclusive(async () => structuredClone((await this.read())
      .filter(record => origin === undefined || record.originConversationId === origin)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))));
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return this.exclusive(async () => structuredClone((await this.read()).find(record => record.id === id)));
  }

  async findExecution(conversationId: string, runId?: string | null): Promise<TaskRecord | undefined> {
    return (await this.list()).find(record => record.executionConversationId === conversationId && (runId === undefined || record.runId === runId));
  }

  async put(record: TaskRecord): Promise<void> {
    if (!isTaskRecord(record)) throw new Error('任务记录无效，改动尚未保存。');
    const next = structuredClone(record);

    await this.exclusive(async () => {
      const records = await this.read();
      const prior = records.find(item => item.id === next.id);

      if (prior) {
        if (prior.originConversationId !== next.originConversationId || prior.executionConversationId !== next.executionConversationId) {
          throw new Error('任务归属不能改变，改动尚未保存。');
        }

        if (next.revision < prior.revision || next.controlVersion < prior.controlVersion || next.updatedAt < prior.updatedAt) {
          throw new Error('任务已有更新，旧状态未覆盖当前任务。');
        }

        if (next.revision === prior.revision && !next.delivery && prior.delivery) next.delivery = structuredClone(prior.delivery);

        if (next.delivery && prior.delivery?.id === next.delivery.id
          && (prior.delivery.revision !== next.delivery.revision || prior.delivery.text !== next.delivery.text)) {
          throw new Error('交付编号已用于其他结果，改动尚未保存。');
        }
      }

      const updated = records.filter(item => item.id !== next.id);
      updated.push(next);
      if (this.doc) await this.doc.write(JSON.stringify({ format: 1, tasks: updated }));
      this.records = updated;
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock.run(() => this.doc ? this.doc.exclusive(action) : action());
  }

  private async read(): Promise<TaskRecord[]> {
    if (!this.doc) return structuredClone(this.records);
    const raw = await this.doc.read();
    if (raw === null) return [];

    try {
      return recordsFrom(raw);
    } catch {
      throw new Error('任务记录无法读取，原记录已保留；未接收新改动。');
    }
  }
}
