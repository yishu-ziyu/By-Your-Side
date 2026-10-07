import type { AgentMessage } from '@earendil-works/pi-agent-core';
// 会话上下文仍由 0.84.4 的 buildSessionContext 还原；存储换成 session-log.ts，格式不变。
import { buildSessionContext } from 'pi-session-084';
import type { SessionLogPort } from './session-log.js';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

/** Synchronous checkpoint reads retain the existing task contract. Writes await Pi's durable append. */
export class PiSessionPersistence {
  private entries: SessionEntry[] = [];
  private tail: Promise<void> = Promise.resolve();
  private error: unknown;
  private constructor(readonly native: SessionLogPort) {}
  static async open(native: SessionLogPort): Promise<{ persistence: PiSessionPersistence; messages: AgentMessage[] }> {
    const persistence = new PiSessionPersistence(native);
    const branch = await native.findEntriesOnBranch({order:'oldestFirst'});
    persistence.entries = branch.flatMap(entry => entry.type === 'custom' ? [{ type:'custom' as const, id:entry.id, parentId:entry.parentId, timestamp:new Date(entry.timestamp).toISOString(), customType:entry.customType ?? '', data:entry.data }] : []);

    // SAFETY: 日志条目就是 0.84.4 写下的 JSONL 条目，字段相同。
    return {persistence, messages:currentMessages(buildSessionContext(branch as never).messages)};
  }
  getBranch(): SessionEntry[] { return [...this.entries]; }
  appendCustomEntry(customType: string, data?: Parameters<SessionManager['appendCustomEntry']>[1]): Promise<string> {
    // Capture the checkpoint now, before later task events can mutate nested fields.
    // Optional undefined fields use the existing JSONL representation.
    const durable = data === undefined ? undefined : JSON.parse(JSON.stringify(data));

    return this.enqueue(async () => {
      const id=await this.native.appendCustomEntry(customType,durable);
      const entry=await this.native.getEntry(id);

      if(!entry||entry.type!=='custom')throw new Error('Pi检查点保存后无法读取');
      this.entries.push({type:'custom',id,parentId:entry.parentId,timestamp:new Date(entry.timestamp).toISOString(),customType,data:durable});

      return id;
    });
  }
  appendMessage(message: AgentMessage): Promise<string> {
    // 深拷贝成纯 JSON 再写入日志。
    const durable: AgentMessage = JSON.parse(JSON.stringify(message));

    return this.enqueue(() => this.native.appendMessage(durable));
  }
  async flush(): Promise<void> {
    await this.tail;

    if (this.error) throw this.error;
  }
  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => {
      if (this.error) throw this.error;

      return write();
    });

    this.tail=pending.then(()=>{},error=>{this.error=error;});
    // Event subscribers cannot await; flush at acceptance, tool and settled boundaries reports failure.
    void pending.catch(()=>{});

    return pending;
  }
}

/** 0.84.4 写下的消息与 1.0.4 的消息是同一份 JSON 结构，只是两套类型声明。 */
function currentMessages(messages: ReturnType<typeof buildSessionContext>['messages']): AgentMessage[] {
  // SAFETY: 见上；会话记录里没有 system 消息，其余角色两版字段相同。
  return messages as never;
}
