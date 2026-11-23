import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

type Browser = Awaited<ReturnType<typeof launchRealPath>>;
type GuideUI = { marks: number; strokes: number; spotlights: number; pointers: Array<{ x: number; y: number; guiding: boolean }>; label: string };
type Fixture = { rp: Browser; page: string; panel: string; url: string; tabId: number; ask: (text: string) => Promise<void>; readUI: () => Promise<GuideUI> };
type Inspect = Parameters<typeof startScriptedModel>[2];

export async function withGuidePage(html: string, rules: Rule[], inspect: Inspect, run: (fixture: Fixture) => Promise<void>) {
  requireHeadless();
  const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(req.url === "/next" ? "<title>练习完成</title><h1>练习完成</h1>" : html));
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${siteAddress(site).port}/`;
  const model = await startScriptedModel([
    { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] }, ...rules,
  ], undefined, inspect);
  let rp: Browser | undefined;
  try {
    const browser = rp = await launchRealPath();
    const blank = (await browser.targets()).find(t => t.url === "about:blank");
    assert.ok(blank, "缺少初始网页");
    const page = await browser.attach(blank.targetId);
    await browser.cdp.send("Page.navigate", { url }, page);
    await until(async () => (await browser.evaluate(page, "location.href")) === url, 10_000, "练习页加载");
    const panel = await browser.attach(await browser.openSidePanel());
    const items = modelStorageItems({ providerId: "custom", modelId: "fixture", baseUrl: model.baseUrl, credential: { type: "api_key", key: "local-fixture" } });
    await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)})`);
    const ready = () => until(async () => await browser.evaluate(panel, `document.querySelector("#conversation-new")?.disabled === false && document.querySelector("#send-btn")?.disabled === false && document.querySelector("#think-chip")?.textContent.includes("fixture")`), 60_000, "侧栏会话、发送和练习模型就绪");
    await ready();
    const tabId = await browser.evaluate(panel, `chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === ${JSON.stringify(url)})?.id)`);
    assert.ok(Number.isInteger(tabId), "找不到练习页标签");
    const readUI = async (): Promise<GuideUI> => browser.evaluate(panel, `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => {
      const root = kind => {
        const host = document.querySelector('[data-sideagent-overlay="' + kind + '"]');
        return host ? chrome.dom.openOrClosedShadowRoot(host) : null;
      };
      const visible = node => Number(getComputedStyle(node).opacity) > 0 && node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const countVisible = (shadow, selector) => [...(shadow?.querySelectorAll(selector) ?? [])].filter(visible).length;
      const marks = root("marks"), cursor = root("cursor");
      const pointers = [...(cursor?.querySelectorAll(".cursor") ?? [])].filter(visible).map(el => {
        const { x, y } = el.getBoundingClientRect();
        return { x: Math.round(x), y: Math.round(y), guiding: el.classList.contains("guiding") };
      });
      return { marks: marks?.querySelectorAll(".mark").length ?? 0, strokes: marks?.querySelectorAll(".sketch-frame-path[d]").length ?? 0,
        spotlights: countVisible(marks, ".guide-spotlight"), pointers, label: marks?.querySelector(".mark-label")?.textContent ?? "" };
    }}).then(([frame]) => frame.result)`);
    const ask = async (text: string) => {
      await browser.cdp.send("Page.bringToFront", {}, page);
      await browser.click(panel, "#input"); await browser.typeText(panel, text); await browser.pressEnter(panel);
    };
    await run({ rp: browser, page, panel, url, tabId, ask, readUI });
  } finally {
    try { await rp?.close(); } finally {
      await rp?.remove(); await model.close(); site.closeAllConnections(); site.close();
    }
  }
}

function guide(target: string, say: string, step: number) {
  return { tool: { name: "guide_step", args: { target, say, step } } };
}

export async function waitForGuide(readUI: Fixture["readUI"], label: string) {
  return until(async () => {
    const ui = await readUI();
    return ui.label === label && ui.marks === 1 && ui.strokes > 0 && ui.spotlights === 1 && ui.pointers.some(p => p.guiding) ? ui : null;
  }, 20_000, label, 40);
}

async function key(rp: Browser, page: string, name: string, keyCode: number, code = name) {
  for (const type of ["keyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: name, code, windowsVirtualKeyCode: keyCode, text: type === "keyDown" && name.length === 1 ? name : undefined }, page);
}

async function multiInteraction() {
  const html = `<!doctype html><meta charset="utf-8"><title>表单练习</title>
    <h1>自己填表</h1><main style="margin-top:160vh;padding-bottom:50vh">
    <label>备注 <input id="note"></label><label>密码 <input type="password" id="secret"></label>
    <label>颜色 <select id="color"><option>青色</option><option value="紫色">Violet 紫色</option></select></label>
    <a id="next" target="_blank" href="/next">查看结果</a></main>`;
  const steps = [guide("#note", "输入备注", 1), guide("#secret", "输入练习密码", 2), guide("#color", "选择紫色", 3), guide("#next", "打开结果页", 4)];
  const task = { match: "教我填写练习表单并打开结果页，每步我自己来。", steps: [...steps, { text: "表单练习已结束。" }] };
  const password = randomUUID();
  let leaked = false;
  const results = new Map<string, string>();
  const inspect: Inspect = payload => {
    leaked ||= JSON.stringify(payload).includes(password);
    for (const message of payload.messages ?? []) {
      if (message.role !== "tool" || !("tool_call_id" in message) || typeof message.tool_call_id !== "string") continue;
      const content = typeof message.content === "string" ? message.content : message.content?.map(p => p.text).join("") ?? "";
      results.set(message.tool_call_id, content);
    }
  };
  await withGuidePage(html, [task], inspect, async ({ rp, page, panel, url, ask, readUI }) => {
    assert.equal(await rp.evaluate(page, "document.querySelector('#note').getBoundingClientRect().top > innerHeight && scrollY === 0"), true);
    await ask(task.match);
    const checkResult = async (step: number, changed: string) => {
      const result = await until(async () => [...results.values()].find(text => text.startsWith(`Step ${step} done:`)), 12_000, `模型收到第 ${step} 步的结果`);
      assert.ok(result.includes(`(${changed};`), `第 ${step} 步应返回 ${changed}`);
      return result;
    };
    await waitForGuide(readUI, "输入备注");
    assert.equal(await rp.evaluate(page, "scrollY > 0 && document.querySelector('#note').getBoundingClientRect().bottom <= innerHeight"), true);
    await rp.click(page, "#note"); await rp.typeText(page, "周五交付"); await rp.pressEnter(page);
    assert.ok((await checkResult(1, "input")).includes("周五交付"));
    await waitForGuide(readUI, "输入练习密码");
    await rp.click(page, "#secret"); await rp.typeText(page, password); await rp.pressEnter(page);
    assert.equal(await rp.evaluate(page, `document.querySelector("#secret").value === ${JSON.stringify(password)}`), true);
    assert.ok((await checkResult(2, "input")).includes("filled=true (redacted)"));
    await waitForGuide(readUI, "选择紫色");
    await key(rp, page, "Tab", 9);
    assert.equal(await rp.evaluate(page, "document.activeElement.id"), "color");
    await key(rp, page, "v", 86, "KeyV");
    assert.equal(await rp.evaluate(page, "document.querySelector('#color').value"), "紫色");
    assert.ok((await checkResult(3, "select")).includes("紫色"));
    await waitForGuide(readUI, "打开结果页");
    await rp.click(page, "#next");
    await checkResult(4, "new_tab");
    await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === url + "next"), 10_000, "新标签页加载结果");
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("表单练习已结束。")) && !document.querySelector("#send-btn").classList.contains("stopping")`), 20_000, "教学结束");
    const ui = await readUI();
    assert.equal(ui.marks, 0); assert.equal(ui.spotlights, 0);
    assert.equal(results.size, 4);
    assert.equal(leaked, false, "模型请求包含练习密码明文");
    console.log("PASS 视口外输入、密码回读脱敏、原生下拉框、新标签页、结束后圈和聚光灯归零");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await multiInteraction();
