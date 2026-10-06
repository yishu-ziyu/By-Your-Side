/**
 * 侧栏壳探针（docs/evals/20261006-sidepanel-shell-quiet.md）：只装扩展的无头 Chrome、真侧栏。
 * 读当前页标签是否在输入框外、边注能否从 ＋ 菜单切换（原在 ··· 菜单，见 20261006-composer-quiet.md）、顶栏图标，并截图。
 *
 *   npx tsx scripts/probes/shell/quiet-shell.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";

requireHeadless();

const out = join(REPO, "out/probes/shell");

await mkdir(out, { recursive: true });

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><meta charset=\"utf-8\"><title>订票</title><h1>订票</h1>"));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const rp = await launchRealPath();

const result: Record<string, string | boolean> = {};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  await sleep(800);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#tab-title-text\")?.textContent.includes(\"订票\")") || undefined, 20_000, "页面标签");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(800);
  result.pillInsideComposer = await rp.evaluate(panel, "!!document.querySelector(\"#composer #page-pill\")");
  result.pillAboveComposer = await rp.evaluate(panel, "document.querySelector(\"#page-pill\").getBoundingClientRect().bottom <= document.querySelector(\"#composer\").getBoundingClientRect().top + 1");
  result.pillText = String(await rp.evaluate(panel, "document.querySelector(\"#page-pill\").innerText.trim()"));
  result.marginaliaVisible = await rp.evaluate(panel, "[...document.querySelectorAll(\"select, .marginalia-control\")].some((e) => e.getClientRects().length > 0)");
  result.topbar = String(await rp.evaluate(panel, "JSON.stringify({ title: document.querySelector(\"#conversation-switcher\").innerText, svgInTitle: !!document.querySelector(\"#conversation-switcher svg\"), icons: [...document.querySelectorAll(\"#conversation-new svg, #header-more svg\")].map((s) => s.getAttribute(\"class\")) })"));
  await rp.screenshot(panel, join(out, "idle.png"));
  await rp.click(panel, "#attach-btn");
  await sleep(300);
  await rp.screenshot(panel, join(out, "menu.png"));
  await rp.click(panel, "#attach-menu [data-marginalia=\"source\"]");
  await sleep(300);
  result.modeAfterPick = String(await rp.evaluate(panel, "document.querySelector(\"#marginalia-mode\").value"));
  result.menuClosed = await rp.evaluate(panel, "document.querySelector(\"#attach-menu\").hidden");
  await rp.click(panel, "#attach-btn");
  await sleep(300);
  result.checked = String(await rp.evaluate(panel, "document.querySelector(\"#attach-menu [aria-checked=true]\")?.dataset.marginalia"));
  await rp.click(panel, "#conversation-switcher");
  await sleep(300);
  result.switcherOpens = await rp.evaluate(panel, "document.querySelector(\"#conversation-menu\").hidden === false");
} finally {
  console.log(JSON.stringify(result, null, 2));
  await rp.close().catch(() => undefined);
  site.closeAllConnections();
  site.close();
}
