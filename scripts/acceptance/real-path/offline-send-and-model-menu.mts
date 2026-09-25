/**
 * 两条不需要真实模型凭据的用户路径（GitHub #4、#2），只装扩展，和日常 Chrome 停用本机宿主后的形态一致。
 *
 *   npx tsx scripts/acceptance/real-path/offline-send-and-model-menu.mts --headless
 *
 * 模型服务换成本机一个假的 OpenAI 兼容地址，像用户一样在设置页选「自定义」、填地址和一个没人认识的模型名保存；
 * 另给 OpenAI 填一把假 key（不发请求），让菜单里同时有已知服务商的模型。假服务只替代模型回答，被测的界面与连接都是真的。
 *
 * #4 断线发送：网页上划一句 → 页内「解释」→「在侧栏继续」把引用带进侧栏 → 侧栏写好一句话 → 扩展内 agent 反复崩溃期间按回车。
 *    判据：正文和引用都还在、侧栏出现「没有发出去」提示、没有冒出已发送的用户消息、假服务没收到这句；
 *    恢复连接后再按一次回车，这句只送达一次（没送到而侧栏给出「继续」时点一次，分开记录 deliveredWithoutHelp）。
 * #2 模型菜单：点模型芯片打开菜单，再点「显示全部」。判据：未知模型和 OpenAI 模型旁都没有任何能力标签，芯片上也没有。
 */
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";

requireHeadless();

const startedAt = new Date().toISOString();
const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.replace(/[:.]/g, "-")}-offline-send-and-model-menu`);
await mkdir(artifacts, { recursive: true });

const UNKNOWN_MODEL = "unseen-model-7x";
const QUOTE = "海獭睡觉时会手牵着手，免得被水流冲散。";
const DRAFT = "把这句改写成适合讲给小朋友听的话";
const QUOTE2 = "一只海獭每天要吃掉相当于体重四分之一的食物。";
const DRAFT2 = "这个比例和人类比起来算多吗";
const ANSWER = "这是本机假模型的固定回答。";

type DomNode = { nodeName: string; nodeValue?: string; backendNodeId: number; children?: DomNode[]; shadowRoots?: DomNode[] };

// ── 本机假模型 + 练习页 ─────────────────────────────────────────
const modelRequests: string[] = [];
const readBody = (req: IncomingMessage) => new Promise<string>((done) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => done(body)); });

const server = createServer(async (req, res) => {
  if (req.url === "/article") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>海獭小知识</title><main style="font:18px/1.8 sans-serif;padding:40px;max-width:640px"><h1>海獭小知识</h1><p>海獭生活在北太平洋沿岸。<span id="quote">${QUOTE}</span>它们还会用石头敲开贝壳。</p><p>海獭没有厚厚的脂肪层。<span id="quote2">${QUOTE2}</span>所以它们几乎一直在找吃的。</p></main>`);

    return;
  }

  if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
    const body = await readBody(req);
    modelRequests.push(body);
    // SAFETY: OpenAI 兼容请求体，stream 是布尔。
    const stream = (JSON.parse(body) as { stream?: boolean }).stream;
    const base = { id: "fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: UNKNOWN_MODEL };

    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));

      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");

    return;
  }

  res.writeHead(404).end();
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(server).port}`;

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    status: q("#status-text")?.textContent?.trim() ?? "",
    input: q("#input")?.value ?? "",
    quoteVisible: visible(q("#ask-cite")),
    quote: q("#ask-cite-text")?.textContent ?? "",
    notices: [...document.querySelectorAll("#messages .msg.notice")].map((el) => el.innerText.trim()),
    userMessages: [...document.querySelectorAll("#messages .msg.user")].map((el) => el.innerText.trim()),
    modelName: q("#model-name")?.textContent?.trim() ?? "",
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; status: string; input: string; quoteVisible: boolean; quote: string; notices: string[]; userMessages: string[]; modelName: string; transcript: string };

const paths: Record<string, JsonRecord> = {};
const result: JsonRecord = { case: "offline-send-and-model-menu", startedAt, modelOrigin: origin, unknownModel: UNKNOWN_MODEL };
const rp = await launchRealPath({ withoutNativeHost: true });
result.browser = rp.browser;

const shot = async (session: string, name: string) => { await rp.screenshot(session, join(artifacts, name)); return name; };

/** 封闭 shadow root 里的按钮：CDP 穿透找到后按实际位置点击，和鼠标点一样。 */
const clickShadowButton = async (session: string, text: string, timeoutMs = 15_000) => {
  const textOf = (node: DomNode): string => (node.nodeValue ?? "") + (node.children ?? []).map(textOf).join("");

  const find = (node: DomNode): DomNode | undefined => {
    if (node.nodeName === "BUTTON" && textOf(node).trim() === text) return node;

    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = find(child);

      if (found) return found;
    }

    return undefined;
  };

  await until(async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const button = find((await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode }).root);

    if (!button) return undefined;
    const { object } = await rp.cdp.send("DOM.resolveNode", { backendNodeId: button.backendNodeId }, session);
    const box = (await rp.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){if(this.closest('[hidden]'))return null;const r=this.getBoundingClientRect();return r.width&&!this.disabled?{x:r.x+r.width/2,y:r.y+r.height/2}:null}", returnByValue: true }, session)).result.value;

    if (!box) return undefined;

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...box }, session);

    return true;
  }, timeoutMs, `页面上的「${text}」按钮`);
};

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/article` }, work);
  await until(async () => (await rp.evaluate(work, `!!document.querySelector("#quote")`).catch(() => false)) || undefined, 15_000, "练习页加载");

  const panelTarget = await rp.openSidePanel();
  const panel = await rp.attach(panelTarget);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#header-more")`)) || undefined, 15_000, "侧栏渲染");

  // ── 设置页：像用户一样填 ────────────────────────────────────
  // 侧栏刚渲染时第一下偶尔没打开菜单（inproc-config 里同样的已知现象）：像用户一样再点，最多 3 次。
  for (let clicks = 1; !(await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`)); clicks++) {
    if (clicks > 3) throw new Error("点了 3 次「更多」，菜单都没有打开");
    await rp.click(panel, "#header-more");
    await until(async () => (await rp.evaluate(panel, `document.querySelector("#header-menu")?.matches(":popover-open")`)) || undefined, 2_000, "更多菜单展开").catch(() => undefined);
  }

  await rp.click(panel, "#model-settings-open");
  const settingsTarget = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  const settings = await rp.attach(settingsTarget.targetId);
  await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");

  // 设置页比视口长：先把目标滚进视口再点，和用户滚动后点击一样。
  const settingsClick = async (selector: string) => {
    await rp.evaluate(settings, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, selector);
  };

  const saveProvider = async (provider: string, fill: Array<[string, string]>) => {
    await rp.evaluate(settings, `(() => { const b = document.querySelector('.provider-option[data-provider="${provider}"]'); b.closest("details") && (b.closest("details").open = true); b.scrollIntoView({ block: "center" }); return true; })()`);
    await rp.click(settings, `.provider-option[data-provider="${provider}"]`);
    await until(async () => (await rp.evaluate(settings, `!document.querySelector("#provider-form").hidden`)) || undefined, 5_000, "服务商表单展开");

    for (const [selector, value] of fill) {
      await settingsClick(selector);
      await rp.evaluate(settings, `document.querySelector(${JSON.stringify(selector)}).select()`);
      await rp.typeText(settings, value);
    }

    await settingsClick("#model-save");

    return until(async () => {
      const text = String(await rp.evaluate(settings, `document.querySelector("#model-status").textContent`));

      if (text && !text.startsWith("已保存")) throw new Error(`保存 ${provider} 失败：${text}`);

      return text.startsWith("已保存") ? text : undefined;
    }, 10_000, `保存 ${provider}`);
  };

  // OpenAI 只填一把假 key 让它的模型进菜单；不点测试，也不会拿它发任务。
  result.openaiSave = await saveProvider("openai", [["#api-key", "sk-fake-not-a-real-key"], ["#model-id", "gpt-4o-mini"]]);
  result.customSave = await saveProvider("custom", [["#base-url", `${origin}/v1`], ["#api-key", "local-fake"], ["#model-id", UNKNOWN_MODEL]]);
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId }).catch(() => {});

  const ready: PanelState = await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL);

    return state.connected && state.modelName.includes(UNKNOWN_MODEL) ? state : undefined;
  }, 30_000, "侧栏连上扩展内 agent 并显示未知模型", 300);
  result.ready = ready;

  // ── 路径 #2：打开模型菜单 ───────────────────────────────────
  {
    await rp.click(panel, "#model-btn");
    await until(async () => (await rp.evaluate(panel, `document.querySelectorAll("#model-popover .model-item").length`)) > 0 || undefined, 5_000, "模型菜单展开");
    await sleep(700);
    const featuredShot = await shot(panel, "2-model-menu-featured.png");
    // 默认只列常用；点「显示全部」列出所有已配置凭据的模型（含 OpenAI），两种视图都要没有猜出来的标签。
    await rp.click(panel, "#model-popover .model-scope-toggle");
    await until(async () => (await rp.evaluate(panel, `document.querySelectorAll('#model-popover .model-item[data-model^="openai/"]').length`)) > 0 || undefined, 5_000, "显示全部后出现 OpenAI 模型").catch(() => undefined);
    await sleep(500);
    const menu = await rp.evaluate(panel, `(() => {
      const pop = document.querySelector("#model-popover");
      const tag = document.querySelector("#model-reasoning-tag");
      return {
        items: [...pop.querySelectorAll(".model-item")].map((el) => ({ id: el.dataset.model, text: el.innerText.trim(), tags: el.querySelectorAll(".reasoning-tag").length })),
        groups: [...pop.querySelectorAll(".model-group")].map((el) => el.innerText.trim()),
        popoverTags: pop.querySelectorAll(".reasoning-tag").length,
        popoverText: pop.innerText,
        chipTagVisible: !!tag && !tag.hidden && tag.getClientRects().length > 0,
        chipText: document.querySelector("#model-btn").innerText.trim(),
      };
    })()`);
    const screenshot = await shot(panel, "2-model-menu-all.png");
    // SAFETY: 上面页面脚本返回的形状。
    const m = menu as { items: Array<{ id: string; text: string; tags: number }>; groups: string[]; popoverTags: number; popoverText: string; chipTagVisible: boolean; chipText: string };
    const unknown = m.items.find((item) => item.id?.endsWith(UNKNOWN_MODEL));
    const openai = m.items.filter((item) => item.id?.startsWith("openai/"));
    const guessedWords = m.popoverText.match(/极速|档位|可调|深度思考|推理/g) ?? [];
    const pass = !!unknown && unknown.tags === 0 && openai.length > 0 && m.popoverTags === 0 && !m.chipTagVisible && guessedWords.length === 0;
    paths.modelMenuUnknownModel = { issue: "#2", pass, featuredShot, screenshot, unknownItem: unknown ?? null, openaiItems: openai.length, openaiItemsWithTags: openai.filter((item) => item.tags > 0).length, groups: m.groups, popoverTags: m.popoverTags, chipTagVisible: m.chipTagVisible, chipText: m.chipText, guessedWords };
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
  }

  // ── 路径 #4：带引用的草稿在断线时发送 ─────────────────────────
  // 两种断线分别跑：扩展后台 service worker 被停（MV3 空闲/更新时常见），扩展内 agent 的 offscreen 文档崩溃。
  // 断线期间把对应目标一出现就关掉，直到「恢复」：模拟连续故障，给用户按回车留出稳定的断线窗口。
  const offlineSend = async (kind: string, crash: () => Promise<boolean>, quoteId: string, quoteText: string, draft: string) => {
    const steps: JsonRecord = { disconnect: kind };
    const draftRequests = () => modelRequests.filter((body) => body.includes(draft)).length;
    let crashing = false;
    let crashLoop: Promise<void> = Promise.resolve();

    try {
      await rp.cdp.send("Page.bringToFront", {}, work);
      // 先点一下页面空白处，收起上一轮页内的阅读框（焦点留在框里时不会弹出新的划词工具条）。
      for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: 600, y: 700, button: "left", clickCount: 1 }, work);
      await sleep(300);
      // 用鼠标从句首拖到句尾选中这句。
      // SAFETY: 页面脚本返回句子的左右端点坐标。
      const span = await rp.evaluate(work, `(() => { const r = document.querySelector("#${quoteId}").getClientRects(); const a = r[0], b = r[r.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; })()`) as { x1: number; y1: number; x2: number; y2: number };
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1, y: span.y1 }, work);
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x1, y: span.y1, button: "left", clickCount: 1 }, work);

      for (let i = 1; i <= 8; i++) await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x1 + ((span.x2 - span.x1) * i) / 8, y: span.y1 + ((span.y2 - span.y1) * i) / 8, button: "left", buttons: 1 }, work);
      await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x2, y: span.y2, button: "left", clickCount: 1 }, work);
      steps.selected = String(await rp.evaluate(work, `getSelection().toString()`));

      await clickShadowButton(work, "解释");
      await clickShadowButton(work, "在侧栏继续", 30_000);
      steps.pageAfterHandoff = await shot(work, `4-${kind}-0-page-handoff.png`);

      const quoted: PanelState = await until(async () => {
        const state: PanelState = await rp.evaluate(panel, PANEL);

        return state.quoteVisible && state.quote.includes(quoteText.slice(0, 8)) ? state : undefined;
      }, 20_000, "侧栏出现引用", 300);
      steps.quoted = quoted;

      await rp.click(panel, "#input");
      await rp.typeText(panel, draft);
      steps.beforeScreenshot = await shot(panel, `4-${kind}-1-draft-with-quote.png`);
      const userMessagesBefore = quoted.userMessages.length;
      const requestsBefore = draftRequests();

      crashing = true;
      let crashes = 0;
      crashLoop = (async () => {
        while (crashing) {
          if (await crash().catch(() => false)) crashes++;

          await sleep(50);
        }
      })();

      if (kind === "worker") {
        // 侧栏对 worker 停机的设计是先排队、换端口后补发，不进入「没发出去」：断线期间按回车，只核对没丢、没发两次。
        await sleep(1500);
        await rp.pressEnter(panel);
        await sleep(2000);
        const duringDown: PanelState = await rp.evaluate(panel, PANEL);
        steps.duringDown = duringDown;
        steps.failedScreenshot = await shot(panel, `4-${kind}-2-send-while-worker-stopped.png`);
      } else {
        const down: PanelState = await until(async () => {
          const state: PanelState = await rp.evaluate(panel, PANEL);

          return state.connected ? undefined : state;
        }, 10_000, "侧栏显示连接断开", 100);
        steps.statusWhileDown = down.status;
        await rp.pressEnter(panel);
        await sleep(800);
        const afterFailed: PanelState = await rp.evaluate(panel, PANEL);
        steps.failedScreenshot = await shot(panel, `4-${kind}-2-send-while-disconnected.png`);
        steps.afterFailed = afterFailed;
        const newNotices = afterFailed.notices.filter((text) => !quoted.notices.includes(text));

        steps.keptWhileDown = {
          draftKept: afterFailed.input === draft,
          quoteKept: afterFailed.quoteVisible && afterFailed.quote === quoted.quote,
          notSentNotice: newNotices.some((text) => text.includes("没有发出去")),
          noFakeUserMessage: afterFailed.userMessages.length === userMessagesBefore,
          modelDidNotReceive: draftRequests() === requestsBefore,
        };
      }

      crashing = false;
      await crashLoop;
      steps.crashes = crashes;

      const back: PanelState = await until(async () => {
        const state: PanelState = await rp.evaluate(panel, PANEL);

        return state.connected ? state : undefined;
      }, 45_000, "连接恢复", 300);
      steps.reconnectedScreenshot = await shot(panel, `4-${kind}-3-reconnected.png`);
      steps.back = back;
      if (kind !== "worker") {
        steps.keptAfterReconnect = back.input === draft && back.quoteVisible && back.quote === quoted.quote;
        await rp.click(panel, "#input");
        await rp.pressEnter(panel);
      }

      // 重发后等回答结束或出错；不管送没送达都留下画面。
      await until(async () => {
        const state: PanelState = await rp.evaluate(panel, PANEL);

        return state.userMessages.some((text) => text.includes(draft)) && draftRequests() > requestsBefore ? state : undefined;
      }, 30_000, "重发后送达", 300).catch(() => undefined);
      await sleep(3000);
      steps.retryScreenshot = await shot(panel, `4-${kind}-4-retry.png`);
      steps.deliveredWithoutHelp = draftRequests() - requestsBefore === 1;

      // 没送到模型、侧栏给了「继续」：像用户一样点一次，看这句是否还在、能否接着送达。
      if (!steps.deliveredWithoutHelp) {
        const continued = await rp.evaluate(panel, `(() => { const b = [...document.querySelectorAll("#messages button, #app button")].find((el) => el.innerText.trim() === "继续" && el.getClientRects().length > 0); if (!b) return false; b.scrollIntoView({ block: "center" }); b.click(); return true; })()`);
        steps.clickedContinue = continued === true;

        if (continued === true) {
          await until(async () => draftRequests() > requestsBefore || undefined, 30_000, "点继续后送达", 300).catch(() => undefined);
          await sleep(3000);
          steps.continueScreenshot = await shot(panel, `4-${kind}-5-after-continue.png`);
        }
      }

      const final: PanelState = await rp.evaluate(panel, PANEL);
      steps.afterRetry = final;
      steps.retry = {
        userMessageShown: final.userMessages.filter((text) => text.includes(draft)).length === 1,
        modelReceivedOnce: draftRequests() - requestsBefore === 1,
        inputCleared: final.input === "",
        noErrorShown: !/CONVERSATION_NOT_FOUND|出错|失败/.test(final.transcript.slice(final.transcript.indexOf(draft))),
      };
    } catch (error) {
      steps.error = error instanceof Error ? error.message : String(error);
      steps.errorScreenshot = await shot(panel, `4-${kind}-error.png`).catch(() => null);
      steps.errorPanel = await rp.evaluate(panel, PANEL).catch(() => null);
    } finally {
      crashing = false;
      await crashLoop;
    }

    // SAFETY: 上面写入的判据都是布尔记录。
    const all = (key: string) => !!steps[key] && Object.values(steps[key] as Record<string, boolean>).every(Boolean);
    const pass = !steps.error && Number(steps.crashes) > 0 && (kind === "worker" || (all("keptWhileDown") && steps.keptAfterReconnect === true)) && all("retry");
    paths[`offlineSend-${kind}`] = { issue: "#4", pass, ...steps };
    // 下一种断线从已连接的状态开始。
    await until(async () => (await rp.evaluate(panel, PANEL) as PanelState).connected || undefined, 45_000, "下一轮前连接恢复", 300).catch(() => undefined);
  };

  // 后台 worker：用 DevTools 的 stopAllWorkers 停掉（和 Chrome 空闲回收、更新时一样），侧栏重连会再拉起它。
  await rp.cdp.send("ServiceWorker.enable", {}, work);
  const stopWorker = async () => {
    if (!(await rp.serviceWorker())) return false;
    await rp.cdp.send("ServiceWorker.stopAllWorkers", {}, work);

    return true;
  };

  // 扩展内 agent：它的 offscreen 文档一出现就关掉，相当于反复崩溃。
  const crashAgent = async () => {
    const doc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);

    if (!doc) return false;
    await rp.cdp.send("Target.closeTarget", { targetId: doc.targetId });

    return true;
  };

  await offlineSend("worker", stopWorker, "quote", QUOTE, DRAFT);
  await offlineSend("agent", crashAgent, "quote2", QUOTE2, DRAFT2);
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  result.cleanup = await rp.close();
  server.close();
}

result.paths = paths;
result.pass = !result.error && Object.keys(paths).length === 3 && Object.values(paths).every((p) => p.pass === true);
await writeFile(join(artifacts, "result.json"), JSON.stringify(result, null, 2));

for (const [name, p] of Object.entries(paths)) console.log(`${name}\t${p.pass ? "pass" : "FAIL"}`);

if (result.error) console.log(`ERROR ${result.error}`);
console.log(`${result.pass ? "PASS" : "FAIL"} · ${artifacts}`);
process.exitCode = result.pass ? 0 : 1;
await rp.remove();
