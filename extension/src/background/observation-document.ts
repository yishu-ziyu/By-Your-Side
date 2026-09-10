import {readCurrentDocument} from './exec/page-readiness.js';

// A selector/ref belongs to the document observed by this execution member, even if the URL is unchanged.
const observed = new Map<string, string>();
const keyOf = (tabId: number, member: string) => `${tabId}:${member}`;
const stale = () => new Error('页面文档已变化，旧目标未执行。请重新 snapshot 或 read_element 核对当前页面和目标。');

export async function withObservedDocument<T>(tabId: number, member: string, read: () => Promise<T>): Promise<T> {
  const before = await readCurrentDocument(tabId);
  const result = await read();
  const after = await readCurrentDocument(tabId);
  if (before?.documentId && after?.documentId !== before.documentId) throw stale();
  if (after?.documentId) recordObservedDocument(tabId, member, after.documentId);
  return result;
}

export function recordObservedDocument(tabId: number, member: string, documentId: string): void {
  if (observed.size >= 512 && !observed.has(keyOf(tabId, member))) observed.delete(observed.keys().next().value!);
  observed.set(keyOf(tabId, member), documentId);
}

export async function assertObservedDocument(tabId: number, member: string): Promise<string | null> {
  const current = await readCurrentDocument(tabId);
  const expected = observed.get(keyOf(tabId, member));
  if (expected && current?.documentId !== expected) throw stale();
  return current?.documentId ?? null;
}

export async function assertSameDocument(tabId: number, expected: string | null): Promise<void> {
  if (expected && (await readCurrentDocument(tabId))?.documentId !== expected) throw stale();
}
