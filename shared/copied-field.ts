import { parseCopyTextRange, type CopyTextRange } from "./copy-range.js";

export interface PreparedCopy { record(result: unknown): void; range?: CopyTextRange }

/** A native copy binds its text to one document and DOM node, not to a reusable selector. */
export interface CopiedFieldProof {
  tabId: number;
  documentId: string;
  backendNodeId: number;
  sha256: string;
  chars: number;
  range?: CopyTextRange;
  requestedRange?: CopyTextRange;
}

export function copiedFieldProof(value: unknown): CopiedFieldProof | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (!Number.isSafeInteger(p.tabId) || Number(p.tabId) < 0
    || typeof p.documentId !== 'string' || !p.documentId
    || !Number.isSafeInteger(p.backendNodeId) || Number(p.backendNodeId) <= 0
    || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)
    || !Number.isSafeInteger(p.chars) || Number(p.chars) < 0) return null;
  const range = p.range === undefined ? undefined : parseCopyTextRange(p.range);
  const requestedRange = p.requestedRange === undefined ? undefined : parseCopyTextRange(p.requestedRange);
  if (range === null || requestedRange === null) return null;
  return { ...(range ? { range } : {}), ...(requestedRange ? { requestedRange } : {}), tabId: Number(p.tabId), documentId: p.documentId, backendNodeId: Number(p.backendNodeId), sha256: p.sha256, chars: Number(p.chars) };
}

export async function textSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
