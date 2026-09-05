/**
 * 最小 CDP 客户端。只连 browser 目标，再 attach 扩展 service worker。
 * 不 attach 普通页面，避免抢走扩展的 chrome.debugger。
 */
export function createCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const sessions = new Map();
  const eventHandlers = new Map();

  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method && eventHandlers.has(m.method)) {
      for (const fn of eventHandlers.get(m.method)) fn(m);
    }
  });

  function ready() {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP WebSocket 连接失败")), { once: true });
    });
  }

  function send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = ++seq;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    ws.send(JSON.stringify(frame));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) rej(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`));
        else res(m.result ?? {});
      });
    });
  }

  async function attachSession(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const att = await send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = att.sessionId;
    if (!sessionId) throw new Error("Target.attachToTarget 未返回 sessionId");
    sessions.set(targetId, sessionId);
    return sessionId;
  }

  function close() {
    return new Promise((res) => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        res();
        return;
      }
      const timer = setTimeout(res, 1000);
      ws.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          res();
        },
        { once: true },
      );
      try {
        ws.close();
      } catch {
        clearTimeout(timer);
        res();
      }
    });
  }

  function onEvent(method, fn) {
    if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
    eventHandlers.get(method).add(fn);
    return () => eventHandlers.get(method)?.delete(fn);
  }

  function waitForEvent(method, timeoutMs = 10_000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        off();
        rej(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = onEvent(method, (m) => {
        clearTimeout(timer);
        off();
        res(m);
      });
    });
  }

  return { ready, send, attachSession, close, ws, onEvent, waitForEvent };
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
  await cdp.ready();
  return { cdp, version };
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
