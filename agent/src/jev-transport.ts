import { Agent, ProxyAgent, fetch, type Dispatcher } from 'undici';

/**
 * TCP + TLS must finish within this. A normal handshake here takes ~0.2 s; the stalls measured on
 * 2026-09-26 took 2–5 s, so a short connect limit leaves time for one retry inside the request budget.
 */
const CONNECT_TIMEOUT_MS = 1000;

/** Keep the connection between loop steps and between tasks instead of re-handshaking every 4 s (undici default). */
const KEEP_ALIVE_MS = 120_000;

export type JevResponse = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; body?: { cancel(): Promise<void> } | null };

let dispatcher: Dispatcher | undefined;

let proxyUrl: string | undefined;

/** The host's explicit proxy setting also carries Jev traffic, as the global dispatcher did before. */
export function useJevProxy(url: string | undefined): void {
  if (url === proxyUrl) return;
  proxyUrl = url;
  const old = dispatcher;
  dispatcher = undefined;
  void old?.close().catch(() => {});
}

/** Node transport for Jev: its own keep-alive pool and connect limit. The extension build swaps in plain fetch. */
export function jevFetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<JevResponse> {
  const options = { keepAliveTimeout: KEEP_ALIVE_MS, keepAliveMaxTimeout: KEEP_ALIVE_MS, connect: { timeout: CONNECT_TIMEOUT_MS } };
  dispatcher ??= proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...options }) : new Agent(options);

  return fetch(url, { ...init, dispatcher });
}
