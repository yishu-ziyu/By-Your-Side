/**
 * 隔离实例：headless Chrome for Testing 加载真实构建的扩展（复制 dist 后去掉 manifest key，
 * 随机扩展 ID，连不上用户正在运行的伴随进程），并用生产 onMessage → executeToolCall 钩子
 * 暴露 __saCall。供多个真实站点验收脚本共用；不碰用户的 ChromeMain 与扩展。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCdp, fetchJson } from "./cdp.mjs";
import { installExecuteToolCallHook } from "./sw-hook.mjs";

/** 本机 Chrome for Testing。缓存目录名带版本号，浏览器更新后旧目录会被清掉，因此按实际存在的最高版本解析。 */
function resolveChrome(): string {
  const override = process.env.EGO_ACCEPTANCE_CHROME;

  if (override) return override;
  const root = join(homedir(), "Library/Caches/ms-playwright");
  const suffix = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

  const versions = existsSync(root)
    ? readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)))
    : [];

  for (const version of versions) {
    const candidate = join(root, version, suffix);

    if (existsSync(candidate)) return candidate;
  }

  throw new Error("未找到 Chrome for Testing：请安装 Playwright 的 Chromium，或用 EGO_ACCEPTANCE_CHROME 指定可执行文件路径。");
}

const CHROME = resolveChrome();

const DIST = resolve("extension/dist");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const value = await fn();

    if (value) return value;
    await sleep(150);
  }

  throw new Error(`等待超时：${label}`);
}

export interface IsolatedExtension {
  outDir: string;
  fixtureOrigin: string;
  fixtureHits(): number;
  swEval(expression: string, timeoutMs?: number): Promise<unknown>;
  tool(name: string, params: Record<string, unknown>, sessionId?: string): Promise<any>;
  /** 打开一个新页并返回它的 CDP target id；配 evalIn 用来驱动真实页面/面板。 */
  newTarget(url: string): Promise<string>;
  evalIn(targetId: string, expression: string, timeoutMs?: number): Promise<any>;
  closeTarget(targetId: string): Promise<void>;
  screenshot(targetId: string, filePath: string): Promise<void>;
  /** Click an existing button, including closed shadow roots, through Chrome input. */
  clickButton(targetId: string, text: string): Promise<void>;
  diagnostics(): IsolationDiagnostics;
  close(): Promise<IsolationCleanup>;
}

/** 隔离启动器自记的诊断快照（准确反映实现返回的字段；CDP 细节保持不透明）。 */
export interface IsolationDiagnostics {
  cdp: unknown;
  fixtureListening: boolean;
  chromePid: number | undefined;
  chromeExit: number | null;
  chromeSignal: NodeJS.Signals | null;
}

export interface IsolationCleanup {
  status: 'PASS' | 'FAIL';
  resources: Record<string, string>;
  errors: string[];
}

// Also used when launch fails before an IsolatedExtension can be returned.
export async function closeIsolatedResources(
  resources: { child?: ChildProcess; cdp?: ReturnType<typeof createCdp>; fixture?: Server },
): Promise<IsolationCleanup> {
  const result: IsolationCleanup = { status: 'PASS', resources: {}, errors: [] };

  const finish = async (name: string, resource: unknown, dispose: () => Promise<void>) => {
    if (!resource) { result.resources[name] = 'NOT_CREATED';

 return; }

    try { await dispose(); result.resources[name] = 'CLOSED'; }
    catch (error) { result.resources[name] = 'FAILED'; result.errors.push(`${name}: ${error}`); result.status = 'FAIL'; }
  };

  await finish('cdp', resources.cdp, () => resources.cdp!.close());
  await finish('chrome', resources.child, async () => {
    const child = resources.child!;

    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve, reject) => {
      const stopped = () => { clearTimeout(timer); resolve(); };

      const timer = setTimeout(() => {
        child.removeListener('close', stopped);
        child.kill('SIGKILL');
        reject(new Error('Chrome graceful close timed out; SIGKILL fallback sent'));
      }, 5000);

      child.once('close', stopped);
      child.kill('SIGTERM');
    });
  });
  await finish('fixture', resources.fixture, async () => {
    const server = resources.fixture!;

    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture close timed out')), 3000);
      server.close(error => { clearTimeout(timer);

 if (error) reject(error); else resolve(); });
      server.closeAllConnections();
    });
  });

  return result;
}

export async function launchIsolatedExtension(options: {hostResolverRules?: string; fixtureHtml?: string; fakeMedia?: boolean; localOnly?: boolean; diagnose?: (kind: string, data: unknown) => void} = {}): Promise<IsolatedExtension> {
  const outDir = await mkdtemp(join(tmpdir(), "sideagent-isolated-"));
  const profile = join(outDir, "profile");
  const extDir = join(outDir, "extension");
  let child: ChildProcess | undefined, fixture: Server | undefined;
  let cdp: ReturnType<typeof createCdp> | undefined;
  let hits = 0, closing: Promise<IsolationCleanup> | undefined;

  const close = () => closing ??= closeIsolatedResources({ child, cdp, fixture }).then(result => {
    options.diagnose?.('isolation-cleanup', { outDir, ...result });

    return result;
  });

  try {
    await cp(DIST, extDir, { recursive: true });
    const manifestPath = join(extDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.key;

    // Test-only transport isolation, applied before the service worker starts.
    // __saCall still enters the real executor; no native host or network uplink can connect.
    if (options.localOnly) {
      manifest.permissions = manifest.permissions.filter((permission: string) => permission !== 'nativeMessaging');
      manifest.content_security_policy = {extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self'"};
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    fixture = createServer((_req, res) => {
      hits += 1;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(options.fixtureHtml ?? "<!doctype html><meta charset='utf-8'><title>isolated probe</title><p>probe</p>");
    });
    await new Promise<void>((resolve, reject) => {
      fixture!.once("error", reject);
      fixture!.listen(0, "127.0.0.1", () => { fixture!.removeListener("error", reject); resolve(); });
    });
    const fixtureOrigin = `http://127.0.0.1:${(fixture!.address() as { port: number }).port}`;

    child = spawn(CHROME, [
      "--headless=new",
      "--mute-audio",
      ...(options.fakeMedia ? ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] : []),
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      ...(options.hostResolverRules ? [`--host-resolver-rules=${options.hostResolverRules}`, "--no-proxy-server"] : []),
      "about:blank",
    ], { stdio: "ignore", env:{...process.env,STEPFUN_API_KEY:undefined,SIDEAGENT_STEP_PLAN_KEY:undefined,TYPESAFE_API_KEY:undefined} });

    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    options.diagnose?.("isolation-started", { outDir, pid: child.pid, fixtureOrigin });

    const port = await until(async () => {
      if (spawnError) throw spawnError;

      if (child!.exitCode !== null) throw new Error(`Chrome exited before ready: ${child!.exitCode}`);

      try {
        return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      } catch {
        return undefined;
      }
    }, 20_000, "Chrome 调试端口");

    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    cdp = createCdp(version.webSocketDebuggerUrl);
    await cdp.ready();

    const found = await until(async () => {
      const targets = await cdp!.send("Target.getTargets");
      const candidates = targets.targetInfos.filter((t: any) => t.type === "service_worker" && /^chrome-extension:\/\//.test(t.url ?? ""));

      for (const candidate of candidates) {
        const session = await cdp!.attachSession(candidate.targetId);
        const probe = await cdp!.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, session);

        if (probe.result?.value === "By Your Side") return { target: candidate, session };
      }

      return undefined;
    }, 20_000, "SideAgent service worker");

    const extensionId = new URL(found.target.url).host;

    const hooked = await installExecuteToolCallHook(cdp, found.session, extensionId, `${fixtureOrigin}/hook`, options.diagnose);

    if (hooked?.ok !== true) throw new Error(`executeToolCall 钩子未装上：${JSON.stringify(hooked)}`);

    const swEval = async (expression: string, timeoutMs = 90_000): Promise<unknown> => {
      const r = await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, found.session, timeoutMs);

      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

      return r.result?.value;
    };

    let seq = 0;

    const tool = (name: string, params: Record<string, unknown>, sessionId = "acpt"): Promise<any> => {
      const id = `iso-${name}-${++seq}`;

      return swEval(`globalThis.__saCall(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(params)}, ${JSON.stringify(sessionId)})`);
    };

    const evalIn = async (targetId: string, expression: string, timeoutMs = 60_000): Promise<any> => {
      const session = await cdp!.attachSession(targetId);
      const r = await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session, timeoutMs);

      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

      return r.result?.value;
    };

    const newTarget = async (url: string): Promise<string> => {
      const created = await cdp!.send("Target.createTarget", { url });

      return created.targetId as string;
    };

    const screenshot = async (targetId: string, filePath: string): Promise<void> => {
      const session = await cdp!.attachSession(targetId);
      const shot = await cdp!.send("Page.captureScreenshot", { format: "png" }, session);
      await writeFile(filePath, Buffer.from(shot.data as string, "base64"));
    };

    const closeTarget = async (targetId: string): Promise<void> => {
      await cdp!.send("Target.closeTarget", { targetId }).catch(() => {});
    };

    const clickButton = async (targetId: string, text: string): Promise<void> => {
      const session = await cdp!.attachSession(targetId);
      const textOf = (node: any): string => (node.nodeValue ?? '') + (node.children ?? []).map(textOf).join('');

      const find = (node: any): any => {
        if (node.nodeName === 'BUTTON' && textOf(node).trim() === text) return node;

        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
          const found = find(child);

          if (found) return found;
        }
      };

      const button = await until(async () => find((await cdp!.send('DOM.getDocument', { depth: -1, pierce: true }, session)).root), 10000, `button ${text}`);
      const { object } = await cdp!.send('DOM.resolveNode', { backendNodeId: button.backendNodeId }, session);
      const location = await cdp!.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}', returnByValue: true }, session);

      for (const type of ['mousePressed', 'mouseReleased']) await cdp!.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...location.result.value }, session);
    };

    return { outDir, fixtureOrigin, fixtureHits: () => hits, swEval, tool, newTarget, evalIn, closeTarget, screenshot, clickButton, diagnostics: () => ({ cdp: cdp!.diagnostics(), fixtureListening: fixture!.listening, chromePid: child!.pid, chromeExit: child!.exitCode, chromeSignal: child!.signalCode }), close };
  } catch (error) {
    const cleanup = await close();
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { isolationCleanup: cleanup });
  }
}
