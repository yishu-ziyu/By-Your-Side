import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionLogEntry, SessionLogPort } from './session-log.js';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

export class PiSessionPersistence {
  private entries: SessionEntry[] = [];
  private tail: Promise<void> = Promise.resolve();
  private error: unknown;
  private constructor(readonly native: SessionLogPort) {}
  static async open(native: SessionLogPort): Promise<{ persistence: PiSessionPersistence; messages: AgentMessage[] }> {
    const persistence = new PiSessionPersistence(native);
    const branch = await native.findEntriesOnBranch({order:'oldestFirst'});
    persistence.entries = branch.flatMap(entry => entry.type === 'custom' ? [{ type:'custom' as const, id:entry.id, parentId:entry.parentId, timestamp:new Date(entry.timestamp).toISOString(), customType:entry.customType ?? '', data:entry.data }] : []);

    return {persistence, messages:branchMessages(branch)};
  }
  getBranch(): SessionEntry[] { return [...this.entries]; }
  appendCustomEntry(customType: string, data?: Parameters<SessionManager['appendCustomEntry']>[1]): Promise<string> {
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
    void pending.catch(()=>{});

    return pending;
  }
}

function branchMessages(branch: SessionLogEntry[]): AgentMessage[] {
  return branch.flatMap(entry => {
    if (entry.type !== 'message') return [];
    const message = entry.message as AgentMessage;

    return message.role === 'assistant' && message.stopReason === 'deferred' ? [] : [message];
  });
}
