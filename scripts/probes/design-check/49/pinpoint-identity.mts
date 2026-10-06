/**
 * #49 定位前提小实验（不接模型）：扩展内容脚本是否注入、侧栏发 PINPOINT_DOM_TARGET identity 能否到达页面。
 * 2026-10-06 结果：host-resolver 映射的 a-review.test 上内容脚本不注入（无 bys-sonar 样式、无扩展 isolated 上下文、identity 失败）；
 * 同一服务换成 127.0.0.1 时内容脚本注入。原因未查明，视为隔离环境限制。
 */
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../../acceptance/real-path/harness.mts";

requireHeadless();

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>评测</title><p>价格：官方售价为 1899 元。</p><p>续航：150 分钟。</p>`));

await new Promise<void>((d) => site.listen(0, "127.0.0.1", d));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP a-review.test 127.0.0.1:${siteAddress(site).port}`] });

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: "http://a-review.test/" }, work);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "page");
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#send-btn")`)) || undefined, 30_000, "panel");
  const ev: string[] = [];
  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { name: string; origin: string; auxData?: { type?: string } } } }) => { if (m.sessionId === work) ev.push(`ctx ${m.params.context.auxData?.type} ${m.params.context.name} ${m.params.context.origin}`); });
  rp.cdp.onEvent("Runtime.exceptionThrown", (m: { sessionId?: string; params: { exceptionDetails: { text: string; url?: string; exception?: { description?: string } } } }) => { if (m.sessionId === work) ev.push(`exc ${m.params.exceptionDetails.url ?? ""} ${m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text}`); });
  rp.cdp.onEvent("Runtime.consoleAPICalled", (m: { sessionId?: string; params: { type: string; args: Array<{ value?: unknown; description?: string }> } }) => { if (m.sessionId === work) ev.push(`console.${m.params.type} ${m.params.args.map((a) => String(a.value ?? a.description)).join(" ").slice(0, 300)}`); });
  await rp.cdp.send("Runtime.enable", {}, work);
  await rp.cdp.send("Page.reload", {}, work); await sleep(2500);
  console.log("events:", ev.join("\n"));
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work); await sleep(2500);
  console.log("127.0.0.1 sonar style:", await rp.evaluate(work, `[...document.querySelectorAll("style")].some((s) => s.textContent.includes("bys-sonar"))`), "contentType", await rp.evaluate(work, "document.contentType"));
  await rp.cdp.send("Page.navigate", { url: "http://a-review.test/" }, work); await sleep(2500);
  console.log("events2:", ev.join("\n"));
  console.log("after late reload, sonar style:", await rp.evaluate(work, `[...document.querySelectorAll("style")].some((s) => s.textContent.includes("bys-sonar"))`));
  const t = await rp.evaluate(panel, `chrome.tabs.create({ url: "http://a-review.test/?new" }).then((t) => t.id)`); await sleep(3000);
  const nt = (await rp.targets()).find((x) => x.url.includes("?new"));
  console.log("new tab", t, "sonar style:", nt ? await rp.evaluate(await rp.attach(nt.targetId), `[...document.querySelectorAll("style")].some((s) => s.textContent.includes("bys-sonar"))`) : "no target");
  console.log("manifest content_scripts:", JSON.stringify(await rp.evaluate(panel, `chrome.runtime.getManifest().content_scripts`)), "host_permissions:", JSON.stringify(await rp.evaluate(panel, `chrome.runtime.getManifest().host_permissions ?? null`)), JSON.stringify(await rp.evaluate(panel, `chrome.permissions.getAll()`)));
  console.log("sonar style in page:", await rp.evaluate(work, `[...document.querySelectorAll("style")].some((s) => s.textContent.includes("bys-sonar"))`));

  for (const wait of [0, 3000]) {
    await sleep(wait);
    console.log(`after +${wait}ms`, JSON.stringify(await rp.evaluate(panel, `(async () => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url?.includes("a-review.test"));
      const id = await chrome.runtime.sendMessage({ type: "PINPOINT_DOM_TARGET", action: "identity", tabId: tab.id, url: tab.url }).catch((e) => ({ thrown: String(e) }));
      let direct; try { direct = await chrome.tabs.sendMessage(tab.id, { type: "PINPOINT_DOM_TARGET", action: "identity", tabId: tab.id, url: tab.url }, { frameId: 0 }); } catch (e) { direct = { thrown: String(e) }; }
      return { tab: { id: tab.id, url: tab.url, status: tab.status }, viaBackground: id, directToTab: direct };
    })()`)));
  }
} finally { await rp.close(); await rp.remove(); site.close(); }
