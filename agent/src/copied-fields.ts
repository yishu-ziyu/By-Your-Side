import type { CopyTextRange } from "../../shared/copy-range.js";
import { copiedFieldProof, textSha256, type CopiedFieldProof } from '../../shared/copied-field.js';
import type { ToolRpc } from './rpc.js';

export interface CopyCheck {
  id: string;
  status: 'same' | 'different' | 'unknown';
  expectedChars?: number;
  actualChars?: number;
  reason?: string;
  range?: CopyTextRange;
  requestedRange?: CopyTextRange;
}

/** Kept only for the current user request; neither source text nor replacement selectors are retained. */
export class CopiedFields {
  private scope = '';
  private fields = new Map<string, { id: string; proof: CopiedFieldProof | null }>();
  private nextId = 0;
  private overflow = false;

  private useScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.fields.clear();
    this.nextId = 0;
    this.overflow = false;
  }

  has(scope: string): boolean { this.useScope(scope); return this.fields.size > 0; }

  record(result: unknown, scope: string): void {
    this.useScope(scope);
    const proof = copiedFieldProof(result && typeof result === 'object' && 'copyProof' in result ? result.copyProof : null);
    const id = `copy-${++this.nextId}`;
    const key = proof ? `${proof.tabId}:${proof.documentId}:${proof.backendNodeId}` : id;
    if (this.fields.size >= 128 && !this.fields.has(key)) { this.overflow = true; return; }
    this.fields.set(key, { id, proof });
  }

  async check(rpc: ToolRpc, scope: string, memberId: string | undefined, current: () => boolean, rebase = false): Promise<CopyCheck[]> {
    this.useScope(scope);
    const entries = [...this.fields.values()];
    const results: CopyCheck[] = this.overflow ? [{id:'copy-overflow',status:'unknown'}] : [];
    const deadline = Date.now() + 4_000;
    for (const { id, proof } of entries) {
      const report: CopyCheck = { id, status: 'unknown', ...(proof ? { expectedChars: proof.chars, ...(proof.range ? {range:proof.range} : {}), ...(proof.requestedRange ? {requestedRange:proof.requestedRange} : {}) } : {}) };
      results.push(report);
      if (!proof || !current() || Date.now() >= deadline) { report.reason = !proof ? 'identity_missing' : !current() ? 'request_changed' : 'timeout'; continue; }
      const target = `@${proof.backendNodeId}`;
      try {
        const data: unknown = await rpc.call('read_element', {
          tabId: proof.tabId, target, properties: ['value'],
          copyRead: { documentId: proof.documentId, deadline, nodeIdentity: { kind: 'ax', backendNodeId: proof.backendNodeId } },
        }, deadline - Date.now(), memberId);
        if (!current() || !data || typeof data !== 'object') continue;
        const field = data as Record<string, unknown>;
        const node = field.nodeIdentity as Record<string, unknown> | undefined;
        if (field.tabId !== proof.tabId || field.documentId !== proof.documentId || field.target !== target
          || node?.kind !== 'ax' || node.backendNodeId !== proof.backendNodeId || typeof field.value !== 'string') continue;
        const sha256 = await textSha256(field.value);
        if (!current()) continue;
        report.actualChars = [...field.value].length;
        if (rebase) { proof.sha256 = sha256; proof.chars = report.actualChars; delete proof.range; delete proof.requestedRange; delete report.range; delete report.requestedRange; }
        report.status = sha256 === proof.sha256 ? 'same' : 'different';
      } catch (error) { report.reason = error instanceof Error ? error.message.slice(0, 120) : 'read_failed'; }
    }
    return results;
  }
}
