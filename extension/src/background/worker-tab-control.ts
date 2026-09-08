import { isLeadSession } from "../../../shared/protocol.js";
import { getTabResource, getWorkingTabId, reclaimWorkerTabs, claimGlobalTab } from "./state.js";
import { executionKey, parseExecutionKey } from "./tab-bindings.js";

const STOPPED = "worker 已停止，页面已交回父 Agent；操作未执行";

/** 注册整个调用（包括异步权限检查），移交前排空；停止标记跨 SW 重启保留。 */
export class WorkerTabControl {
  private readonly stopped = new Set<string>();
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();

  isStopped(key: string): boolean { return this.stopped.has(key); }

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped.has(key)) return Promise.reject(new Error(STOPPED));
    const jobs = this.inflight.get(key) ?? new Set<Promise<unknown>>();
    this.inflight.set(key, jobs);
    const job = Promise.resolve().then(async () => {
      const stored = await chrome.storage.session.get(`stoppedWorker:${key}`);
      if (stored[`stoppedWorker:${key}`]) this.stopped.add(key);
      if (this.stopped.has(key)) throw new Error(STOPPED);
      return operation();
    });
    jobs.add(job);
    void job.finally(() => { jobs.delete(job); if (!jobs.size) this.inflight.delete(key); }).catch(() => {});
    return job;
  }

  async manage(params: { action: "inspect" | "release" | "claim"; tabId?: number; workerId?: string; expectedConversationId?: string | null }, leadKey: string, discardPendingClicks: (key: string) => void = () => {}, canTake: (keys: string[]) => Promise<void> = async () => {}) {
    const lead = parseExecutionKey(leadKey);
    if (!isLeadSession(lead.sessionId)) throw new Error("只有父 Agent 可以管理 worker 页面");
    if (params.action === "release") {
      if (!params.workerId || isLeadSession(params.workerId) || params.workerId.includes("::")) throw new Error("无效的 worker 身份");
      const workerKey = executionKey(lead.conversationId, params.workerId);
      this.stopped.add(workerKey);
      discardPendingClicks(workerKey);
      await chrome.storage.session.set({ [`stoppedWorker:${workerKey}`]: true });
      await Promise.allSettled([...(this.inflight.get(workerKey) ?? [])]);
      discardPendingClicks(workerKey);
      return { tabIds: await reclaimWorkerTabs(leadKey, workerKey), workers: [] };
    }
    if (params.action !== "inspect" && params.action !== "claim") throw new Error("无效的页面管理操作");
    const tabId = params.tabId ?? await getWorkingTabId(leadKey);
    if (tabId == null) throw new Error("没有可接管的标签页");
    await chrome.tabs.get(tabId);
    const resource = await getTabResource(tabId);
    const conversationId = resource?.conversationId ?? null;
    const activeMembers: string[] = [];
    for (const key of resource?.collaborators ?? []) {
      const member = parseExecutionKey(key).sessionId;
      if (!isLeadSession(member) || await getWorkingTabId(key) === tabId) activeMembers.push(member);
    }
    const workers = (resource?.collaborators ?? []).map(key => parseExecutionKey(key).sessionId).filter(id => !isLeadSession(id));
    if (params.action === "claim") {
      const expected = params.expectedConversationId === undefined ? lead.conversationId : params.expectedConversationId;
      if (conversationId !== expected) throw new Error("页面归属已变化，请重新查看后再接手");
      if (conversationId === lead.conversationId && workers.length) throw new Error("worker 仍持有页面；请先停止并等待页面移交");
      const previous = (resource?.collaborators ?? []).filter(key => key !== leadKey);
      await canTake([...previous, leadKey]);
      const frozen = previous.filter(key => !this.stopped.has(key) && activeMembers.includes(parseExecutionKey(key).sessionId));
      frozen.forEach(key => { this.stopped.add(key); discardPendingClicks(key); });
      try {
        await Promise.allSettled(previous.flatMap(key => [...(this.inflight.get(key) ?? [])]));
        previous.forEach(discardPendingClicks);
        await canTake([...previous, leadKey]);
        await claimGlobalTab(tabId, leadKey, expected);
      } finally { frozen.forEach(key => this.stopped.delete(key)); }
    }
    return { tabId, workers, conversationId, owned: !!resource, foreign: !!resource && conversationId !== lead.conversationId, members: activeMembers };
  }
}

export const workerTabControl = new WorkerTabControl();
