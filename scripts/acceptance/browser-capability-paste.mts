/**
 * CAP-02B C6：隔离无头富文本 paste 端到端（真实 macOS pasteboard 桥）。
 *
 * 失败判据（先于桥接实现固定在此）：
 * 1. 无 --headless → 拒绝运行（exit 2）
 * 2. 隔离构建不得改写日常 extension/dist
 * 3. 富文本编辑器粘贴 text+html 后，独立 DOM 读回必须看到夹具规定的链接结构
 * 4. 禁止用 innerHTML 赋值或合成 paste 事件冒充成功（走正式 paste RPC）
 * 5. 粘贴前后可读 changeCount；并发改剪贴板时桥返回 changed 且不覆盖 → 记未破坏
 * 6. 测试结束必须把剪贴板恢复到开始时；恢复失败写入 result.json，不得假装已恢复
 *
 * 用法：npx tsx scripts/acceptance/browser-capability-paste.mts --headless
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv.includes("--headless")) {
  console.error("Required: --headless（本脚本只以 --headless=new 隔离无头运行）");
  process.exit(2);
}

if (process.platform !== "darwin") {
  console.error("本脚本需要 macOS pasteboard");
  process.exit(2);
}

const repo = resolve(import.meta.dirname, "../..");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const out = resolve(repo, "out/acceptance", `browser-capability-paste-${stamp}`);

await mkdir(out, { recursive: true });

const PASTE_TEXT = "cap02b-paste-link";

const PASTE_HREF = "https://example.com/cap02b-paste-fixture";

const PASTE_HTML = `<a href="${PASTE_HREF}">${PASTE_TEXT}</a>`;

type Verdict = "yes" | "no" | "未破坏用户剪贴板" | "BLOCKED";

type Assertion = { id: string; ok: boolean; detail?: unknown };

type ScenarioResult = {
  id: string;
  verdict: Verdict;
  entry: string;
  assertions: Assertion[];
  independent: Record<string, unknown>;
  error?: string;
};

const scenarios: ScenarioResult[] = [];

const record: {
  ok: boolean;
  status: "PASS" | "FAIL" | "BLOCKED";
  command: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  gitHead?: string;
  build: Record<string, unknown>;
  identity: Record<string, unknown>;
  scenarios: ScenarioResult[];
  clipboard: {
    restoredAtEnd: boolean | null;
    restoreError?: string;
    note: string;
  };
  cleanup?: unknown;
  error?: string;
} = {
  ok: false,
  status: "FAIL",
  command: "npx tsx scripts/acceptance/browser-capability-paste.mts --headless",
  exitCode: null,
  startedAt: new Date().toISOString(),
  build: {},
  identity: {},
  scenarios,
  clipboard: {
    restoredAtEnd: null,
    note: "不写用户剪贴板正文；只记录代次与恢复是否成功",
  },
};

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

function check(sc: ScenarioResult, id: string, ok: boolean, detail?: unknown): boolean {
  const detailExtra = detail !== undefined ? { detail } : {};
  sc.assertions.push({ id, ok, ...detailExtra });

  return ok;
}

const fixtureHtml = `<!doctype html>
<meta charset=utf-8>
<title>CAP-02B paste fixture</title>
<style>
  #editor { min-height: 120px; border: 1px solid #333; padding: 12px; font: 16px/1.4 sans-serif; }
</style>
<div id="editor" contenteditable="true" data-testid="rich-editor"></div>
<script>
window.__pasteOracle = function() {
  const ed = document.getElementById('editor');
  const a = ed.querySelector('a[href="${PASTE_HREF}"]');
  return {
    hasRequiredLink: !!a,
    linkText: a ? String(a.textContent || '') : null,
    href: a ? a.getAttribute('href') : null,
    childElementCount: ed.childElementCount,
    // 只回传结构标记，不回传系统剪贴板
    textSample: (ed.innerText || '').slice(0, 80),
  };
};
</script>`;

const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  if ((req.url ?? "/") === "/" || (req.url ?? "").startsWith("/paste")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml);

    return;
  }

  res.writeHead(404);
  res.end("missing");
});

await new Promise<void>((resolveListen, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", () => {
    fixture.removeListener("error", reject);
    resolveListen();
  });
});

const fixturePort = (fixture.address() as { port: number }).port;

const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

const {
  startClipboardDarwinHttpServer,
  capturePasteboardGuard,
  darwinPasteboardChangeCount,
  darwinPasteboardWriteText,
  darwinClipboardBegin,
  darwinClipboardFinish,
} = await import("../../agent/src/clipboard-darwin.js");

let clipboardHttp: Awaited<ReturnType<typeof startClipboardDarwinHttpServer>> | undefined;

let pasteboardGuard: Awaited<ReturnType<typeof capturePasteboardGuard>> | undefined;

let iso: Awaited<ReturnType<typeof import("./isolated-extension.mts").launchIsolatedExtension>> | undefined;

try {
  pasteboardGuard = await capturePasteboardGuard();
  clipboardHttp = await startClipboardDarwinHttpServer(0);
  const changeCountAtStart = await darwinPasteboardChangeCount();

  const dailyDistPath = join(repo, "extension/dist/background.js");
  const dailyDistBefore = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;
  record.gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  const isoRoot = await mkdtemp(join(tmpdir(), "sideagent-paste-dist-"));
  const buildDir = join(isoRoot, "extension", "dist");

  const build = spawnSync("node", ["build.mjs"], {
    cwd: join(repo, "extension"),
    env: { ...process.env, SIDEAGENT_BUILD_DIST: buildDir },
    encoding: "utf8",
  });

  const builtBg = join(buildDir, "background.js");
  const dailyDistAfterBuild = existsSync(dailyDistPath) ? sha256(await readFile(dailyDistPath)) : null;
  record.build = {
    exitCode: build.status,
    outDir: buildDir,
    dailyDistBefore,
    dailyDistAfterBuild,
    dailyDistUnchanged: dailyDistBefore === dailyDistAfterBuild,
    backgroundSha256: existsSync(builtBg) ? sha256(await readFile(builtBg)) : null,
    stderrTail: (build.stderr ?? "").split("\n").slice(-8),
    clipboardHttpPort: clipboardHttp.port,
  };

  if (build.status !== 0 || !existsSync(builtBg)) {
    record.status = "FAIL";
    record.error = "隔离构建失败";
    record.exitCode = 1;
    throw new Error("隔离构建失败");
  }

  if (dailyDistBefore !== dailyDistAfterBuild) {
    record.status = "FAIL";
    record.error = "日常 extension/dist 被改写";
    record.exitCode = 1;
    throw new Error("日常 extension/dist 被改写");
  }

  const prevCwd = process.cwd();
  process.chdir(isoRoot);
  let launchIsolatedExtension: typeof import("./isolated-extension.mts").launchIsolatedExtension;

  try {
    ({ launchIsolatedExtension } = await import("./isolated-extension.mts"));
  } finally {
    process.chdir(prevCwd);
  }

  const { ToolRpc } = await import("../../agent/src/rpc.js");
  const { createBrowserTools } = await import("../../agent/src/tools.js");

  // 不使用 localOnly：扩展需 fetch 本机 clipboard HTTP
  iso = await launchIsolatedExtension({ fixtureHtml });
  await iso.swEval(
    `globalThis.__SIDEAGENT_CLIPBOARD_URL__ = ${JSON.stringify(clipboardHttp.url)}`,
  );

  const bridgePresent = await iso.swEval(
    `typeof globalThis.__saClipboardBridge === "function" && !!globalThis.__saClipboardBridge()`,
  );

  record.identity = {
    extensionId: await iso.swEval("chrome.runtime.id"),
    bridgePresent,
    clipboardUrlSet: true,
    fixtureOrigin,
    host: "createBrowserTools→ToolRpc→__saCall→paste",
    changeCountAtStart,
  };

  const rpcEvents: Array<Record<string, unknown>> = [];

  const rpc = new ToolRpc((frame) => {
    rpcEvents.push({ at: Date.now(), kind: "rpc-start", id: frame.id, name: frame.name });
    const args = [frame.id, frame.name, frame.params, frame.sessionId ?? "main", frame.programId ?? null, "paste"];
    void iso!.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then(
      (r: any) => {
        rpcEvents.push({ at: Date.now(), kind: "rpc-end", id: frame.id, name: frame.name, ok: r?.ok, error: r?.error });
        rpc.handleResult(frame.id, r?.ok === true, r?.data, r?.error, r?.executionFact);
      },
      (e: unknown) => {
        rpc.handleResult(frame.id, false, undefined, String(e));
      },
    );
  });

  const tools = createBrowserTools(rpc);

  const runTool = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);

    if (!tool) throw new Error(`missing tool ${name}`);

    return tool.execute(`paste-${name}-${Date.now()}`, params as never, undefined, undefined, {} as never) as Promise<{
      content: Array<{ text: string }>;
      details?: any;
    }>;
  };

  // ── 场景 1：富文本链接粘贴 ─────────────────────────────────────────
  {
    const sc: ScenarioResult = {
      id: "C6-rich-link",
      verdict: "no",
      entry: "createBrowserTools paste → ToolRpc → extension paste → Darwin clipboard bridge",
      assertions: [],
      independent: {},
    };

    scenarios.push(sc);

    check(sc, "bridge registered in SW", bridgePresent === true, bridgePresent);

    const opened = await runTool("tabs", { action: "open", url: `${fixtureOrigin}/paste` });
    const tabMatch = /tab (\d+)/i.exec(opened.content?.[0]?.text ?? "");
    const tabId = tabMatch ? Number(tabMatch[1]) : NaN;
    check(sc, "tabs open", Number.isFinite(tabId), opened.content?.[0]?.text?.slice(0, 120));

    await runTool("snapshot", { tabId });
    await runTool("click", { target: "#editor", tabId });
    await runTool("js", {
      code: `(() => { const el = document.getElementById("editor"); el?.focus(); return { active: document.activeElement?.id ?? null, focused: document.activeElement === el }; })()`,
      tabId,
    });
    const beforePaste = await darwinPasteboardChangeCount();

    let pasteError = "";
    let pasteDetails: any;

    try {
      const pasted = await runTool("paste", {
        content: { text: PASTE_TEXT, html: PASTE_HTML },
        tabId,
      });

      pasteDetails = pasted.details;
      check(sc, "paste RPC ok", true, {
        clipboard: pasteDetails?.clipboard,
        textHead: pasted.content?.[0]?.text?.slice(0, 80),
      });
    } catch (e) {
      pasteError = String(e);
      check(sc, "paste RPC ok", false, pasteError.slice(0, 240));
    }

    const afterPaste = await darwinPasteboardChangeCount();

    const oracle = await iso.swEval(`(async()=>{
      const tabs=await chrome.tabs.query({url:${JSON.stringify(`${fixtureOrigin}/paste*`)}});
      if(!tabs.length) return null;
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:tabs[0].id},
        world:'MAIN',
        func:()=>window.__pasteOracle?.() ?? null
      });
      return result;
    })()`);

    sc.independent = {
      changeCountBefore: beforePaste,
      changeCountAfter: afterPaste,
      pasteClipboardStatus: pasteDetails?.clipboard ?? null,
      pasteError: pasteError ? pasteError.slice(0, 200) : null,
      page: oracle,
      required: { href: PASTE_HREF, text: PASTE_TEXT },
    };

    check(
      sc,
      "independent has required link structure",
      !!(oracle as any)?.hasRequiredLink &&
        (oracle as any)?.href === PASTE_HREF &&
        (oracle as any)?.linkText === PASTE_TEXT,
      oracle,
    );
    check(
      sc,
      "paste did not report BLOCKED host",
      !/PASTE_HOST_BLOCKED|BLOCKED/.test(pasteError),
      pasteError.slice(0, 120),
    );
    check(
      sc,
      "clipboard finish restored or changed (not silent fail)",
      pasteDetails?.clipboard === "restored" || pasteDetails?.clipboard === "changed",
      pasteDetails?.clipboard ?? null,
    );

    sc.verdict = sc.assertions.every((a) => a.ok) ? "yes" : "no";
  }

  // ── 场景 2：并发改剪贴板 → changed 且不覆盖 ───────────────────────
  {
    const sc: ScenarioResult = {
      id: "C6-concurrent-changed",
      verdict: "no",
      entry: "bridge beginTemporary → 外部写入 → finish",
      assertions: [],
      independent: {},
    };

    scenarios.push(sc);

    const { changeCount } = await darwinClipboardBegin({
      text: "sideagent-temp-should-not-stick",
      html: "<b>sideagent-temp-should-not-stick</b>",
    });

    const afterBegin = await darwinPasteboardChangeCount();
    check(sc, "begin returns changeCount", Number.isFinite(changeCount), { changeCount, afterBegin });

    const externalCount = await darwinPasteboardWriteText("user-concurrent-clipboard-marker");
    check(sc, "external write bumped changeCount", externalCount !== changeCount, {
      begin: changeCount,
      external: externalCount,
    });

    const status = await darwinClipboardFinish(changeCount);
    check(sc, "finish returns changed", status === "changed", status);

    // 不覆盖：并发后的代次应仍是外部写入后的代次（或更高），且 status=changed 表示未 restore
    const afterFinish = await darwinPasteboardChangeCount();
    sc.independent = {
      beginChangeCount: changeCount,
      externalChangeCount: externalCount,
      afterFinishChangeCount: afterFinish,
      finishStatus: status,
      note: "changed 表示未把快照写回，用户并发内容保留",
    };
    check(sc, "user clipboard not overwritten by restore", status === "changed", status);

    sc.verdict = sc.assertions.every((a) => a.ok) ? "未破坏用户剪贴板" : "no";
  }

  record.ok = scenarios.every((s) => s.verdict === "yes" || s.verdict === "未破坏用户剪贴板");
  record.status = record.ok ? "PASS" : "FAIL";
  record.exitCode = record.ok ? 0 : 1;
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  record.status = "FAIL";
  record.exitCode = 1;
  record.ok = false;
} finally {
  if (iso) {
    try {
      record.cleanup = await iso.close();
    } catch (e) {
      record.cleanup = { error: String(e) };
    }
  }

  try {
    await new Promise<void>((res, rej) => fixture.close((err) => (err ? rej(err) : res())));
  } catch (e) {
    record.clipboard.restoreError = `fixture close: ${String(e)}`;
  }

  if (clipboardHttp) {
    try {
      await clipboardHttp.close();
    } catch {
      /* */
    }
  }

  if (pasteboardGuard) {
    try {
      await pasteboardGuard.restore();
      record.clipboard.restoredAtEnd = true;
    } catch (e) {
      record.clipboard.restoredAtEnd = false;
      record.clipboard.restoreError = e instanceof Error ? e.message : String(e);
      // 恢复失败不得假装成功
      record.ok = false;
      record.status = "FAIL";
      record.exitCode = 1;
    }
  } else {
    record.clipboard.restoredAtEnd = false;
    record.clipboard.restoreError = "guard was not captured";
    record.ok = false;
    record.status = "FAIL";
    record.exitCode = 1;
  }

  record.finishedAt = new Date().toISOString();
  await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify(
      {
        status: record.status,
        ok: record.ok,
        exitCode: record.exitCode,
        out,
        scenarios: scenarios.map((s) => ({ id: s.id, verdict: s.verdict })),
        clipboardRestored: record.clipboard.restoredAtEnd,
      },
      null,
      2,
    ),
  );
  process.exit(record.exitCode ?? 1);
}
