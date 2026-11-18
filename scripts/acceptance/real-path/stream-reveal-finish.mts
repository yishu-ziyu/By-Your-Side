import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const dir = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stream-reveal-finish`);
const source = join(REPO, "extension/src/sidepanel/stream-reveal.ts");
const task = "total = 21\npassed = 12\nrate = passed / total * 100\nprint(f\"Agent 成功率：{rate:.1f}%\")【这个的结果会是什么？为什么】";
const answer = `输出是：\`Agent 成功率：57.1%\`

原因是这三步：

- \`passed / total\` = 12 / 21 = 0.5714285714…（真除法，不会像老式 Python 那样整除成 0）
- \`* 100\` → 57.1428571428…
- \`f"{rate:.1f}"\` 里的 \`.1f\` 表示定点格式、保留 1 位小数，做的是四舍五入（round-half-even，但这里 57.14… 离 57.15 还有距离），所以 57.142857… → \`57.1\`

顺带两个容易踩的点：如果你想要的是「约 57%」这种整数展示，得再套一层 \`:.0f\`；而 \`f"{rate:.1%}"\` 会把 0.5714… 直接格式化成 \`57.1%\`，此时不能再乘 100，否则会变成 5714.3%。`;

type Panel = { text: string; revealing: boolean; fades: number; idle: boolean; animated: boolean };
type Fade = { from: number; to: number; at: number };
type RangeCase = { html: string; fades: Fade[]; spans: [string, string][] };

const rangeCases: RangeCase[] = [
  {
    html: "<p>012345678901234567890123456789</p>",
    fades: [{ from: 0, to: 18, at: 10 }, { from: 6, to: 14, at: 20 }],
    spans: [["012345", "-90ms"], ["67890123", "-80ms"], ["4567", "-90ms"]],
  },
  {
    html: '<p>abcd<strong>efgh</strong><span class="gen-card">ijk</span>lmn</p>',
    fades: [{ from: 12, to: 99, at: 10 }, { from: 3, to: 12, at: 30 }, { from: 3, to: 6, at: 40 }, { from: 4, to: 5, at: 20 }],
    spans: [["d", "-60ms"], ["ef", "-60ms"], ["gh", "-70ms"], ["l", "-70ms"], ["mn", "-90ms"]],
  },
  {
    html: '<p><a href="#source" class="cited-number">57.1%</a> / 短🙂</p>',
    fades: [{ from: 30, to: 60, at: 20 }, { from: 5, to: 5, at: 20 }, { from: 8, to: 3, at: 30 }, { from: -4, to: 2, at: 10 }, { from: 8, to: 99, at: 20 }],
    spans: [["57", "-90ms"], ["短🙂", "-80ms"]],
  },
];

function rangeProbe(cases: RangeCase[], wrap: (nodes: ChildNode[], fades: Fade[], now: number) => void) {
  return cases.map(({ html, fades }) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    const before = host.textContent;
    const elements = [...host.querySelectorAll("*")];
    wrap([...host.childNodes], fades, 100);
    const spans = [...host.querySelectorAll<HTMLSpanElement>(".chunk-fade")];
    const during = host.textContent;
    const cuts = spans.map(span => [span.textContent, span.style.animationDelay]);
    const nested = !!host.querySelector(".chunk-fade .chunk-fade, .gen-card .chunk-fade");
    for (const span of spans) span.dispatchEvent(new Event("animationend"));
    return { before, during, after: host.textContent, cuts, nested, sameElements: elements.every(el => host.contains(el)), htmlAfter: host.innerHTML };
  });
}

async function checkRanges(rp: Awaited<ReturnType<typeof launchRealPath>>, panel: string) {
  const contents = await readFile(process.env.SIDEAGENT_REVEAL_SOURCE ?? source, "utf8");
  const { outputFiles } = await build({
    stdin: { contents: `${contents}\nexport { wrapRanges };`, sourcefile: "stream-reveal.ts", resolveDir: dirname(source), loader: "ts" },
    bundle: true, write: false, format: "iife", globalName: "RevealRangeProbe",
  });
  const results = await rp.evaluate(panel, `(() => { ${outputFiles[0]!.text}\nreturn (${rangeProbe.toString()})(${JSON.stringify(rangeCases)}, RevealRangeProbe.wrapRanges); })()`) as ReturnType<typeof rangeProbe>;
  for (const [index, result] of results.entries()) {
    assert.equal(result.during, result.before, `range ${index}: exact text while animating`);
    assert.equal(result.after, result.before, `range ${index}: exact text after animation`);
    assert.deepEqual(result.cuts, rangeCases[index]!.spans, `range ${index}: winning fade and remaining coverage`);
    assert.ok(!result.nested && result.sameElements, `range ${index}: wrappers leave cards and original elements intact`);
    assert.equal(result.htmlAfter, rangeCases[index]!.html, `range ${index}: original markup after animation`);
  }
  return results;
}

const readPanel = String.raw`(() => {
  const reply = [...document.querySelectorAll('#messages .msg.assistant.markdown')].findLast(el => el.dataset.markdown?.startsWith('输出是：'));
  return {
    text: [...(reply?.querySelectorAll(':scope > p, :scope > ul') ?? [])].map(el => el.innerText).join('\n'),
    revealing: !!reply?.hasAttribute('data-revealing'),
    fades: reply?.querySelectorAll('.chunk-fade').length ?? 0,
    idle: !!reply?.querySelector('.answer-actions') && !document.querySelector('#status-pill.running, #send-btn.stopping, .msg.assistant.streaming, .thinking.streaming'),
    animated: window.revealProbeAnimated === true,
  };
})()`;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const visibleAnswer = normalize(answer.replace(/^\s*- /gm, "").replaceAll("`", ""));

async function checkReplay(rp: Awaited<ReturnType<typeof launchRealPath>>, panel: string, baseUrl: string, exceptions: string[], reduced: boolean) {
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: reduced ? "dark" : "light" },
    { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
  ] }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-fixture" },
  })}).then(() => true)`);
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, `!document.querySelector('#messages .msg.assistant') && document.querySelector('#conversation-new')?.disabled === false && document.querySelector('#send-btn')?.disabled === false`), 10_000, "empty connected sidebar");
  await rp.evaluate(panel, `(() => {
    window.revealProbeAnimated = false;
    window.revealProbeObserver?.disconnect();
    window.revealProbeObserver = new MutationObserver(() => {
      if (document.querySelector('#messages .msg.assistant .chunk-fade')) window.revealProbeAnimated = true;
    });
    window.revealProbeObserver.observe(document.querySelector('#messages'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-revealing'] });
  })()`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, task);
  const start = Date.now();
  await rp.pressEnter(panel);
  const result = await until(async () => {
    const state = await rp.evaluate(panel, readPanel) as Panel;
    assert.deepEqual(exceptions, [], "sidebar runtime exceptions");
    return state.idle && !state.revealing && !state.fades && state;
  }, 15_000, "complete visible answer with finished reveal", 50).catch(async error => {
    throw new Error(`${String(error)}\n${JSON.stringify(await rp.evaluate(panel, readPanel))}`);
  });
  assert.equal(normalize(result.text), visibleAnswer, "exact visible answer (ignoring layout whitespace)");
  assert.equal(result.animated, !reduced, "reveal only animates when motion is enabled");
  await rp.screenshot(panel, join(dir, reduced ? "answer-dark-reduced.png" : "answer.png"));
  return { ...result, elapsedMs: Date.now() - start };
}

const evidence: Record<string, unknown> = {};
const exceptions: string[] = [];
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let model: Awaited<ReturnType<typeof startScriptedModel>> | undefined;
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Public arithmetic replay</title>"));

await mkdir(dir, { recursive: true });
try {
  rp = await launchRealPath();
  const panel = await rp.attach(await rp.openSidePanel());
  if (!process.argv.includes("--replay-only")) evidence.ranges = await checkRanges(rp, panel);
  if (!process.argv.includes("--ranges-only")) {
    await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
    const target = await until(async () => (await rp!.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "isolated work tab");
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, await rp.attach(target.targetId));
    const off = rp.cdp.onEvent("Runtime.exceptionThrown", (event: { sessionId?: string; params: { exceptionDetails: { text: string; exception?: { description?: string } } } }) => {
      if (event.sessionId !== panel) return;
      const details = event.params.exceptionDetails;
      exceptions.push(details.exception?.description ?? details.text);
    });
    await rp.cdp.send("Runtime.enable", {}, panel);
    const pieces = answer.match(/[\s\S]{1,18}/g)!.map((text, index) => ({ text, delayMs: index === 0 ? 0 : 140 }));
    model = await startScriptedModel([
      { match: "USER REQUEST:", steps: [{ text: '{"problems":[]}' }] },
      { match: "[GOAL CHECK]", steps: [{ text: '{"status":"done"}' }] },
      { match: task, steps: [{ text: answer, pieces }] },
    ]);
    evidence.animated = await checkReplay(rp, panel, model.baseUrl, exceptions, false);
    evidence.darkReduced = await checkReplay(rp, panel, model.baseUrl, exceptions, true);
    assert.ok(model.requests.filter(request => request.rule === task && request.finished && request.lastTextAt).length >= 2, "both replays streamed from the local fixture");
    off();
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(dir, "result.json"), JSON.stringify({ status: process.exitCode ? "FAIL" : "PASS", ...evidence, exceptions }, null, 2));
  await rp?.close();
  await rp?.remove();
  await model?.close();
  site.closeAllConnections();
  site.close();
  console.log(dir);
}
