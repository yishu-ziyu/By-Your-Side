/**
 * YIS-74「只填草稿，由用户发送」探针（docs/evals/20261006-draft-only.md）：只装扩展的无头 Chrome、真侧栏。
 * 一、「/ 技能」里不用回答问题的技能：选中后正文进输入框，不发出。
 * 二、页角建议卡（#52）：侧栏关着时卡才出在页角（开着时进侧栏，见 real-path/proactive-card.mts）。先关侧栏，真页面停留、滚动，
 *    脚本模型给出建议，点卡上的按钮；侧栏重新打开，把话接在已有草稿后面，不发出。
 *
 *   npx tsx scripts/probes/shell/draft-only.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/shell");

await mkdir(out, { recursive: true });

const failures: string[] = [];

/** evidence 是已序列化的 JSON 文本：探针只打印，不再解析。 */
const check = (name: string, ok: boolean, evidence: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${evidence}`);

  if (!ok) failures.push(name);
};

const STATE = "({ input: document.querySelector(\"#input\").value, users: document.querySelectorAll(\"#messages .msg.user\").length, stopping: document.querySelector(\"#send-btn\").classList.contains(\"stopping\"), focused: document.activeElement?.id, h: document.querySelector(\"#input\").clientHeight, sh: document.querySelector(\"#input\").scrollHeight, top: document.querySelector(\"#input\").scrollTop })";

const PROMPT = "比较这款耳机在京东和淘宝的价格，列出差价和运费";

const body = "这款降噪耳机京东现价 1299 元，支持主动降噪和空间音频，续航三十小时，提供两年质保。".repeat(12);

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>耳机详情页</title><article>${"<p>" + body + "</p>"}</article><div style="height:3000px"></div>`));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/`;

const offer = { offer: true, sentence: "要比一下别家的价格吗", evidence: [{ text: "耳机详情页", url: pageUrl }], actionLabel: "帮我比价", prompt: PROMPT };

// 建议判断收到的是页面 JSON（含标题）；其余请求不该出现：发出去了就会被判失败（users > 0）。
const model = await startScriptedModel([{ match: "耳机详情页", steps: [{ text: JSON.stringify(offer) }] }, { match: "", steps: [{ text: "不该发出。" }] }]);

const rp = await launchRealPath();

try {
  const panelTarget = await rp.openSidePanel();
  let panel = await rp.attach(panelTarget);
  const items = { sideagent_nudge: true, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#app')?.classList.contains('starter-ready')") || undefined, 60_000, "侧栏草稿恢复完");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);

  // 一、「/ 技能」
  await rp.click(panel, "#input");
  await rp.typeText(panel, "/");
  await until(async () => await rp.evaluate(panel, "[...document.querySelectorAll('#pskill-menu .pskill-item')].some((e) => e.textContent.includes('概括这页'))") || undefined, 5_000, "技能菜单");
  await rp.evaluate(panel, "[...document.querySelectorAll('#pskill-menu .pskill-item')].find((e) => e.textContent.includes('概括这页')).click()");
  await sleep(1500);
  const skill = await rp.evaluate(panel, STATE);
  check("选「概括这页」：正文进输入框，没有发出", skill.input.startsWith("请概括当前页面的要点") && skill.users === 0 && !skill.stopping, JSON.stringify(skill));
  await rp.screenshot(panel, join(out, "draft-skill.png"));

  // 二、建议卡：先关侧栏（草稿已存），真页面停留 15 秒以上并滚动，等卡出现，点卡上的按钮
  await sleep(500);
  await rp.cdp.send("Target.closeTarget", { targetId: panelTarget });
  await until(async () => !(await rp.targets()).some((t) => t.targetId === panelTarget) || undefined, 5_000, "侧栏关上");
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, work);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(2000);
  await rp.evaluate(work, "window.scrollBy(0, 400), true");

  const action = await until(async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work);

    const find = (n: { nodeName?: string; attributes?: string[]; children?: unknown[]; shadowRoots?: unknown[]; backendNodeId: number }): number | undefined => {
      if (n.nodeName === "BUTTON" && (n.attributes ?? []).join(" ").includes("action")) return n.backendNodeId;

      // SAFETY: CDP 的 DOM 节点子树形状同上。
      for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])] as typeof n[]) {
        const hit = find(c);

        if (hit) return hit;
      }

      return undefined;
    };

    return find(root);
  }, 60_000, "建议卡出现", 1000).catch(() => null);

  check("建议卡：停留并滚动后页角出现卡片", action !== null, JSON.stringify({ action }));

  if (action !== null) {
    const { model: box } = await rp.cdp.send("DOM.getBoxModel", { backendNodeId: action }, work);
    const [x1, y1, , , x3, y3] = box.content;
    const at = { x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: "left", clickCount: 1 };
    await rp.screenshot(work, join(out, "draft-nudge-card.png"));
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at }, work);
  }

  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  const nudged = await until(async () => {
    const s = await rp.evaluate(panel, STATE);

    return s.input.includes("比较这款耳机") ? s : undefined;
  }, 5_000, "建议进输入框").catch(() => null);

  await sleep(1500);
  const after = await rp.evaluate(panel, STATE);
  const left = await rp.evaluate(panel, "chrome.storage.session.get('sideagent_nudge_draft').then((r) => r.sideagent_nudge_draft ?? null)");
  check("建议卡：话接在已有草稿后面，原草稿还在，框长高到全看得见，没有发出，存储里取走了", !!nudged && nudged.input.startsWith("请概括当前页面的要点") && nudged.input.endsWith("列出差价和运费") && after.users === 0 && !after.stopping && left === null && nudged.focused === "input" && after.h >= after.sh, JSON.stringify({ nudged, after, left }));
  await rp.screenshot(panel, join(out, "draft-nudge.png"));
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
