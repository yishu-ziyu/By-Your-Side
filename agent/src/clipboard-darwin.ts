/**
 * macOS NSPasteboard 临时写入 / 按 changeCount 恢复。
 *
 * 行为对照 citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e
 * package/ego-browser/src/clipboard.ts（MIT License）。
 *
 * Copyright (c) 2026 CitroLabs
 * Copyright (c) 2026 By Your Side contributors（本文件的 HTTP 适配与 changeCount 回传）
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Writable } from "node:stream";
import type { ClipboardFinishStatus, NormalizedPasteContent } from "../../shared/pointer-input.js";

/** 首选端口：更新前构建的扩展写死连它。被占时伴随进程改用随机端口，经 hello_ok.clipboardPort 告诉扩展。 */
export const DEFAULT_CLIPBOARD_HTTP_PORT = 7761;

export type ClipboardTransactionStatus = ClipboardFinishStatus;

type ClipboardHostMessage = {
  state: "ready" | "restored" | "changed" | "error";
  changeCount?: number;
  message?: string;
  /** opaque; never log */
  snapshot?: unknown;
};

type ActiveTxn = {
  child: ChildProcessWithoutNullStreams;
  messages: ReturnType<typeof clipboardMessages>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  changeCount: number;
  finished: boolean;
};

let transactionQueue: Promise<void> = Promise.resolve();

let active: ActiveTxn | null = null;

let releaseActiveQueue: (() => void) | null = null;

/**
 * 写入临时 text/html，返回写入后的 changeCount。
 * 快照留在 JXA 子进程内存，不进入 Node 堆、不写日志。
 */
export async function darwinClipboardBegin(
  content: NormalizedPasteContent,
): Promise<{ changeCount: number }> {
  if (process.platform !== "darwin") {
    throw new Error("clipboard bridge requires macOS");
  }

  let release!: () => void;
  const previous = transactionQueue;
  transactionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    if (active) throw new Error("clipboard transaction already active");

    const child = spawn(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", DARWIN_CLIPBOARD_HOST],
      { stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );

    const messages = clipboardMessages(child.stdout);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.stdin.end(JSON.stringify(content), "utf8");
    const first = await nextHostMessage(messages, exit, () => stderr);

    if (first.state !== "ready" || typeof first.changeCount !== "number") {
      release();
      throw new Error(first.message || "could not prepare the macOS clipboard");
    }

    releaseActiveQueue = release;
    active = {
      child,
      messages,
      exit,
      stderr: () => stderr,
      changeCount: first.changeCount,
      finished: false,
    };

    return { changeCount: first.changeCount };
  } catch (error) {
    release();
    throw error;
  }
}

export async function darwinClipboardFinish(
  expectedChangeCount: number,
): Promise<ClipboardTransactionStatus> {
  const txn = active;

  if (!txn) throw new Error("no clipboard transaction");

  if (txn.finished) throw new Error("clipboard transaction already finished");
  txn.finished = true;
  active = null;
  const release = releaseActiveQueue;
  releaseActiveQueue = null;

  try {
    void expectedChangeCount;
    const signalPipe = txn.child.stdio[3] as Writable | null;

    if (!signalPipe) throw new Error("clipboard restore pipe is unavailable");
    signalPipe.end("1");
    const result = await nextHostMessage(txn.messages, txn.exit, txn.stderr);
    const completion = await txn.exit;

    if (completion.code !== 0) {
      throw clipboardHostExitError(completion, txn.stderr());
    }

    if (result.state === "restored" || result.state === "changed") {
      return result.state;
    }

    throw new Error(result.message || "could not restore the macOS clipboard");
  } finally {
    release?.();
  }
}

/** 独立读 changeCount，不读、不回传剪贴板正文。 */
export async function darwinPasteboardChangeCount(): Promise<number> {
  if (process.platform !== "darwin") throw new Error("macOS only");
  const out = await runJxaOnce(DARWIN_CHANGECOUNT_SCRIPT);
  const parsed = JSON.parse(out) as { changeCount: number };

  if (!Number.isFinite(parsed.changeCount)) throw new Error("invalid changeCount");

  return parsed.changeCount;
}

/** 写入纯文本以模拟用户并发改剪贴板（会递增 changeCount）。 */
export async function darwinPasteboardWriteText(text: string): Promise<number> {
  if (process.platform !== "darwin") throw new Error("macOS only");
  const out = await runJxaOnce(DARWIN_WRITE_TEXT_SCRIPT, JSON.stringify({ text }));
  const parsed = JSON.parse(out) as { changeCount: number };

  return parsed.changeCount;
}

export type PasteboardGuard = {
  /** 恢复测试开始时的剪贴板；失败抛错（调用方写入 result.json）。 */
  restore(): Promise<void>;
};

/** 保存当前 pasteboard 全部条目；正文不进入日志。 */
export async function capturePasteboardGuard(): Promise<PasteboardGuard> {
  if (process.platform !== "darwin") throw new Error("macOS only");

  const child = spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", DARWIN_GUARD_HOST],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );

  const messages = clipboardMessages(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end("{}", "utf8");
  const first = await nextHostMessage(messages, exit, () => stderr);

  if (first.state !== "ready") {
    throw new Error(first.message || "could not capture pasteboard");
  }

  let restored = false;

  return {
    async restore() {
      if (restored) return;
      restored = true;
      const signalPipe = child.stdio[3] as Writable | null;

      if (!signalPipe) throw new Error("pasteboard guard pipe unavailable");
      signalPipe.end("1");
      const result = await nextHostMessage(messages, exit, () => stderr);
      const completion = await exit;

      if (completion.code !== 0) throw clipboardHostExitError(completion, stderr);

      if (result.state !== "restored") {
        throw new Error(result.message || "pasteboard guard restore failed");
      }
    },
  };
}

export type ClipboardHttpServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};

/** 扩展桥通过本机 HTTP 调用 begin/finish（只绑 127.0.0.1）。 */
export function startClipboardDarwinHttpServer(
  port = DEFAULT_CLIPBOARD_HTTP_PORT,
): Promise<ClipboardHttpServer> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("clipboard HTTP server requires macOS"));
  }

  const server: Server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      const raw = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(raw),
      });
      res.end(raw);
    };

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        respond(200, { ok: true });

        return;
      }

      if (req.method === "POST" && url.pathname === "/begin") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text : "";
        const html = typeof body.html === "string" ? body.html : undefined;

        const result = await darwinClipboardBegin(
          html === undefined ? { text } : { text, html },
        );

        respond(200, { ok: true, changeCount: result.changeCount });

        return;
      }

      if (req.method === "POST" && url.pathname === "/finish") {
        const body = await readJson(req);
        const expected = Number(body.expectedChangeCount);

        if (!Number.isFinite(expected)) {
          respond(400, { ok: false, error: "expectedChangeCount required" });

          return;
        }

        const status = await darwinClipboardFinish(expected);
        respond(200, { ok: true, status });

        return;
      }

      if (req.method === "GET" && url.pathname === "/changeCount") {
        const changeCount = await darwinPasteboardChangeCount();
        respond(200, { ok: true, changeCount });

        return;
      }

      respond(404, { ok: false, error: "not found" });
    } catch (error) {
      respond(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();

      const bound =
        address && typeof address === "object" ? address.port : port;

      resolve({
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function runJxaOnce(script: string, stdin = "{}"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < 8192) stderr += c;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`osascript exited ${code}: ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(stdin, "utf8");
  });
}

function clipboardMessages(stream: NodeJS.ReadableStream) {
  const queued: ClipboardHostMessage[] = [];

  const waiters: Array<{
    resolve: (message: ClipboardHostMessage) => void;
    reject: (error: unknown) => void;
  }> = [];

  let buffer = "";
  let ended = false;
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    buffer += String(chunk);

    while (true) {
      const newline = buffer.indexOf("\n");

      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (!line) continue;
      let message: ClipboardHostMessage;

      try {
        message = JSON.parse(line);
      } catch {
        const waiter = waiters.shift();

        if (waiter) waiter.reject(new Error(`invalid clipboard host response`));
        continue;
      }

      const waiter = waiters.shift();

      if (waiter) waiter.resolve(message);
      else queued.push(message);
    }
  });
  stream.on("error", (error) => {
    const waiter = waiters.shift();

    if (waiter) waiter.reject(error);
  });
  stream.on("end", () => {
    ended = true;
    const waiter = waiters.shift();

    if (waiter) waiter.reject(new Error("clipboard host closed without a response"));
  });

  return {
    next(): Promise<ClipboardHostMessage> {
      const message = queued.shift();

      if (message) return Promise.resolve(message);

      if (ended) {
        return Promise.reject(new Error("clipboard host closed without a response"));
      }

      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

async function nextHostMessage(
  messages: ReturnType<typeof clipboardMessages>,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: () => string,
): Promise<ClipboardHostMessage> {
  try {
    return await messages.next();
  } catch (error) {
    const completion = await exit;

    if (completion.code !== 0 || completion.signal) {
      throw clipboardHostExitError(completion, stderr());
    }

    throw error;
  }
}

function clipboardHostExitError(
  completion: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
) {
  const detail = stderr.trim();

  return new Error(
    `clipboard host exited ${
      completion.signal ? `on ${completion.signal}` : `with code ${completion.code}`
    }${detail ? `: ${detail}` : ""}`,
  );
}

/** Adapted from ego-lite clipboard.ts DARWIN_CLIPBOARD_HOST; ready also emits changeCount. */
const DARWIN_CLIPBOARD_HOST = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

const pasteboard = $.NSPasteboard.generalPasteboard;
const transactionLock = $.NSDistributedLock.alloc.initWithPath(
  $(ObjC.unwrap($.NSTemporaryDirectory()) + "sideagent-clipboard.lock")
);

function acquireTransactionLock() {
  const deadline = Date.now() + 5000;
  while (!transactionLock.tryLock) {
    const lockDate = transactionLock.lockDate;
    const lockAge = lockDate
      ? Date.now() - Number(lockDate.timeIntervalSince1970) * 1000
      : 0;
    if (lockAge > 30000) {
      transactionLock.breakLock;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another process is using the clipboard");
    }
    $.NSThread.sleepForTimeInterval(0.02);
  }
}

function emit(message) {
  const line = $(JSON.stringify(message) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
}

function snapshotPasteboard() {
  const snapshot = [];
  const sourceItems = pasteboard.pasteboardItems;
  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {
    const sourceItem = sourceItems.objectAtIndex(itemIndex);
    const values = [];
    const types = sourceItem.types;
    for (let typeIndex = 0; typeIndex < Number(types.count); typeIndex += 1) {
      const type = types.objectAtIndex(typeIndex);
      const data = sourceItem.dataForType(type);
      if (data) values.push({ type, data });
    }
    snapshot.push(values);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  const restoredItems = [];
  for (const values of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const value of values) item.setDataForType(value.data, value.type);
    restoredItems.push(item);
  }
  if (!pasteboard.writeObjects($(restoredItems))) {
    throw new Error("NSPasteboard rejected the saved clipboard items");
  }
}

const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const serialized = ObjC.unwrap(
  $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)
);
const parsed = JSON.parse(serialized);
const content = typeof parsed === "string" ? { text: parsed } : parsed;
acquireTransactionLock();
const saved = snapshotPasteboard();

try {
  pasteboard.clearContents;
  if (!pasteboard.setStringForType($(content.text), $.NSPasteboardTypeString)) {
    throw new Error("NSPasteboard rejected the temporary text");
  }
  if (
    content.html !== undefined &&
    !pasteboard.setStringForType($(content.html), $.NSPasteboardTypeHTML)
  ) {
    throw new Error("NSPasteboard rejected the temporary HTML");
  }
} catch (error) {
  try { restorePasteboard(saved); } catch (_) {}
  emit({ state: "error", message: String(error.message || error) });
  transactionLock.unlock;
  throw error;
}

const temporaryChangeCount = Number(pasteboard.changeCount);
emit({ state: "ready", changeCount: temporaryChangeCount });

const restoreSignal = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
restoreSignal.readDataOfLength(1);

try {
  try {
    if (Number(pasteboard.changeCount) !== temporaryChangeCount) {
      emit({ state: "changed" });
    } else {
      restorePasteboard(saved);
      emit({ state: "restored" });
    }
  } catch (error) {
    emit({ state: "error", message: String(error.message || error) });
    throw error;
  }
} finally {
  transactionLock.unlock;
}
`;

const DARWIN_GUARD_HOST = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

const pasteboard = $.NSPasteboard.generalPasteboard;

function emit(message) {
  const line = $(JSON.stringify(message) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
}

function snapshotPasteboard() {
  const snapshot = [];
  const sourceItems = pasteboard.pasteboardItems;
  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {
    const sourceItem = sourceItems.objectAtIndex(itemIndex);
    const values = [];
    const types = sourceItem.types;
    for (let typeIndex = 0; typeIndex < Number(types.count); typeIndex += 1) {
      const type = types.objectAtIndex(typeIndex);
      const data = sourceItem.dataForType(type);
      if (data) values.push({ type, data });
    }
    snapshot.push(values);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  const restoredItems = [];
  for (const values of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const value of values) item.setDataForType(value.data, value.type);
    restoredItems.push(item);
  }
  if (!pasteboard.writeObjects($(restoredItems))) {
    throw new Error("NSPasteboard rejected the saved clipboard items");
  }
}

$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const saved = snapshotPasteboard();
emit({ state: "ready" });
const restoreSignal = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
restoreSignal.readDataOfLength(1);
try {
  restorePasteboard(saved);
  emit({ state: "restored" });
} catch (error) {
  emit({ state: "error", message: String(error.message || error) });
  throw error;
}
`;

const DARWIN_CHANGECOUNT_SCRIPT = String.raw`
ObjC.import("AppKit");
const n = Number($.NSPasteboard.generalPasteboard.changeCount);
$.NSFileHandle.fileHandleWithStandardOutput.writeData(
  $(JSON.stringify({ changeCount: n }) + "\n").dataUsingEncoding($.NSUTF8StringEncoding)
);
`;

const DARWIN_WRITE_TEXT_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const serialized = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding));
const parsed = JSON.parse(serialized);
const pasteboard = $.NSPasteboard.generalPasteboard;
pasteboard.clearContents;
pasteboard.setStringForType($(String(parsed.text || "")), $.NSPasteboardTypeString);
const n = Number(pasteboard.changeCount);
$.NSFileHandle.fileHandleWithStandardOutput.writeData(
  $(JSON.stringify({ changeCount: n }) + "\n").dataUsingEncoding($.NSUTF8StringEncoding)
);
`;
