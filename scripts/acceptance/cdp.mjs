/** Minimal browser CDP client; every pending operation belongs to this socket. */
export function createCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let seq = 0, closedError, closing;
  const pending = new Map(), sessions = new Map(), eventHandlers = new Map();
  const operations = new Set();

  // Attach a rejection observer immediately. Callers still receive the original
  // rejecting promise, including waits created before an awaited trigger fails.
  function operation(label, timeoutMs, subscribe) {
    let resolve, reject, timer, unsubscribe;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});
    const entry = { label, finish(error, value) {
      if (!operations.delete(entry)) return;
      clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error); else resolve(value);
    } };
    operations.add(entry);
    if (closedError) entry.finish(closedError);
    else {
      timer = setTimeout(() => entry.finish(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      try { unsubscribe = subscribe(entry.finish); }
      catch (error) { entry.finish(error); }
      // subscribe may settle synchronously (e.g. a ready socket or aborted wait).
      if (!operations.has(entry)) unsubscribe?.();
    }
    return promise;
  }

  function end(error) {
    if (closedError) return;
    closedError = error;
    for (const entry of [...operations]) entry.finish(error);
    pending.clear(); sessions.clear(); eventHandlers.clear();
  }
  function detachSocketListeners() {
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
  }
  function onClose() { end(new Error('CDP closed: WebSocket 断开')); detachSocketListeners(); }
  function onError() { end(new Error('CDP closed: WebSocket 连接失败')); close().catch(() => {}); }
  function onMessage(ev) {
    let message;
    try { message = JSON.parse(String(ev.data)); }
    catch { onError(); return; }
    if (message.id) pending.get(message.id)?.(message);
    for (const fn of [...(eventHandlers.get(message.method) ?? [])]) fn(message);
  }
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);

  function ready() {
    return operation('CDP ready', 10_000, finish => {
      if (ws.readyState === WebSocket.OPEN) { finish(); return; }
      const opened = () => finish();
      ws.addEventListener('open', opened);
      return () => ws.removeEventListener('open', opened);
    });
  }

  function send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++seq;
    return operation(`CDP ${method}`, timeoutMs, finish => {
      pending.set(id, message => {
        pending.delete(id);
        finish(message.error ? new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`) : null, message.result ?? {});
      });
      try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { pending.delete(id); throw error; }
      return () => pending.delete(id);
    });
  }

  async function attachSession(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    if (!sessionId) throw new Error('Target.attachToTarget 未返回 sessionId');
    if (closedError) throw closedError;
    sessions.set(targetId, sessionId);
    return sessionId;
  }

  function close() {
    if (closing) return closing;
    end(new Error('CDP closed by client'));
    closing = new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.CLOSED) { detachSocketListeners(); resolve(); return; }
      const cleanup = () => { clearTimeout(timer); ws.removeEventListener('close', stopped); detachSocketListeners(); };
      const stopped = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('CDP socket close timed out')); }, 1000);
      ws.addEventListener('close', stopped);
      try { if (ws.readyState !== WebSocket.CLOSING) ws.close(); }
      catch (error) { cleanup(); reject(error); }
    });
    closing.catch(() => {});
    return closing;
  }

  function onEvent(method, fn) {
    if (closedError) throw closedError;
    if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
    eventHandlers.get(method).add(fn);
    return () => {
      const handlers = eventHandlers.get(method);
      handlers?.delete(fn);
      if (!handlers?.size) eventHandlers.delete(method);
    };
  }

  function waitForEvent(method, timeoutMs = 10_000, { sessionId, predicate = () => true, signal } = {}) {
    return operation(`CDP event ${method}`, timeoutMs, finish => {
      const off = onEvent(method, message => {
        if (sessionId && message.sessionId !== sessionId) return;
        try { if (predicate(message)) finish(null, message); }
        catch (error) { finish(error); }
      });
      const abort = () => finish(signal.reason ?? new Error('CDP wait aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      return () => { off(); signal?.removeEventListener('abort', abort); };
    });
  }
  function diagnostics() {
    return { closed: !!closedError, requests: pending.size, operations: [...operations].map(op => op.label), listeners: [...eventHandlers].map(([method, handlers]) => ({ method, count: handlers.size })) };
  }
  return { ready, send, attachSession, close, ws, onEvent, waitForEvent, diagnostics };
}

export async function fetchJson(url, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function connectBrowser(port) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  if (!version?.webSocketDebuggerUrl) {
    throw new Error(`http://127.0.0.1:${port}/json/version 没有 webSocketDebuggerUrl`);
  }
  const cdp = createCdp(version.webSocketDebuggerUrl);
  try {
    await cdp.ready();
    return { cdp, version };
  } catch (error) {
    await cdp.close();
    throw error;
  }
}

export function findServiceWorker(targets, extensionId) {
  const needle = `chrome-extension://${extensionId}/`;
  const list = Array.isArray(targets) ? targets : [];
  return list.find((t) => {
    const url = t.url ?? t.targetInfo?.url ?? "";
    const type = t.type ?? t.targetInfo?.type ?? "";
    return type === "service_worker" && url.startsWith(needle) && url.includes("background.js");
  });
}

export async function evaluateInWorker(cdp, sessionId, expression, timeoutMs = 30_000) {
  await cdp.send("Runtime.enable", {}, sessionId, timeoutMs);
  const r = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
    timeoutMs,
  );
  if (r.exceptionDetails) {
    const desc =
      r.exceptionDetails.exception?.description ??
      r.exceptionDetails.text ??
      JSON.stringify(r.exceptionDetails);
    throw new Error(`service worker evaluate: ${desc}`);
  }
  return r.result?.value;
}
