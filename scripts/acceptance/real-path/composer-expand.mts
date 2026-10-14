/**
 * 输入框空着只留字和发送；点进去、有字、有附件时工具行才展开。只装扩展，脚本模型不需要，无头。
 *
 *   npx tsx scripts/acceptance/real-path/composer-expand.mts --headless
 *
 * 失败方式：空着就露出加号；点进去加号不出现；打完字失焦后工具收回；窄到 320 发送键不见。
 */
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-composer-expand`);
await mkdir(out, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=utf-8><title>对照</title><h1>对照</h1>");
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();
const results: Array<[string, boolean, unknown?]> = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

const blurComposer = (panel: string) => rp.evaluate(panel, `(() => {
  document.querySelector("#attach-btn")?.blur();
  document.querySelector("#input")?.blur();
  const outside = document.querySelector("#conversation-switcher");
  outside?.focus();
  outside?.blur();
  return true;
})()`);

const view = (panel: string) => rp.evaluate(panel, `(() => {
  const inner = document.querySelector("#composer-bar-inner");
  const send = document.querySelector("#send-btn");
  const ics = inner ? getComputedStyle(inner) : null;
  const scs = send ? getComputedStyle(send) : null;
  const sendBox = send?.getBoundingClientRect();
  const hit = (sel) => {
    const el = document.querySelector(sel);
    const box = el?.getBoundingClientRect();
    const at = box && box.width > 0 ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return !!(el && at && el.contains(at));
  };
  return {
    toolsOpen: !!(ics && +ics.opacity > 0.5 && parseFloat(ics.maxHeight) > 8),
    attachClickable: hit("#attach-btn"),
    thinkClickable: hit("#think-chip"),
    inert: !!inner?.inert,
    sendShown: !!(send && scs && scs.display !== "none" && (sendBox?.width ?? 0) > 8),
    starter: !!document.querySelector("#starter-connect"),
    starterTitle: document.querySelector("#starter-title")?.textContent ?? "",
    errorCard: [...document.querySelectorAll(".needs-model-card,.receipt-decision,.msg.error")].some((el) => (el.textContent ?? "").trim().length > 0),
    width: document.documentElement.clientWidth,
  };
})()`) as Promise<{
  toolsOpen: boolean;
  attachClickable: boolean;
  thinkClickable: boolean;
  inert: boolean;
  sendShown: boolean;
  starter: boolean;
  starterTitle: string;
  errorCard: boolean;
  width: number;
}>;

try {
  const tab = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "网页");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, await rp.attach(tab.targetId));
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn") && document.readyState==="complete"`)) || undefined, 30_000, "侧栏就绪");
  await until(async () => (await view(panel)).starter || undefined, 20_000, "空侧栏出现连模型");
  await sleep(400);

  await rp.evaluate(panel, `document.querySelector("#think-chip").hidden = false; true`);
  const idle = await view(panel);
  await rp.screenshot(panel, join(out, "01-idle.png"));
  check("空着：加号收起，发送键在", !idle.toolsOpen && !idle.attachClickable && !idle.thinkClickable && idle.inert && idle.sendShown && idle.starter, idle);
  check("空着：还看得到先连接模型", idle.starterTitle.includes("先连接") || idle.starter, idle.starterTitle);

  await rp.evaluate(panel, `(() => {
    const bar = document.querySelector("#composer-bar");
    const r = bar.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
    at?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + 20, clientY: r.top + r.height / 2 }));
    return true;
  })()`);
  await sleep(350);
  const fromBar = await view(panel);
  check("点发送键左边空白：工具展开", fromBar.toolsOpen && fromBar.attachClickable && fromBar.sendShown && !fromBar.inert, fromBar);
  await blurComposer(panel);
  await sleep(350);

  await rp.click(panel, "#input");
  await sleep(450);
  const focused = await view(panel);
  await rp.screenshot(panel, join(out, "02-focus.png"));
  check("点进去：加号展开，发送键还在", focused.toolsOpen && focused.attachClickable && focused.sendShown, focused);
  await rp.click(panel, "#attach-btn");
  await sleep(350);
  const menuOpen = await rp.evaluate(panel, `!document.querySelector("#attach-menu")?.hidden`);
  await rp.click(panel, "#attach-btn");
  await sleep(250);
  check("点进去后加号能打开附件菜单", menuOpen === true, { menuOpen });

  await blurComposer(panel);
  await sleep(450);
  const blurred = await view(panel);
  await rp.screenshot(panel, join(out, "03-blur.png"));
  check("空着失焦：工具收回", !blurred.toolsOpen && !blurred.attachClickable && blurred.sendShown, blurred);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "整理这一页");
  await blurComposer(panel);
  await sleep(450);
  const typed = await view(panel);
  await rp.screenshot(panel, join(out, "04-has-text.png"));
  check("有字失焦：工具还开着", typed.toolsOpen && typed.attachClickable && typed.sendShown, typed);

  await rp.evaluate(panel, `document.querySelector("#input").value=""; document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#input").blur(); true`);
  await sleep(450);
  const cleared = await view(panel);
  check("清空后：工具收回", !cleared.toolsOpen && !cleared.attachClickable && cleared.sendShown, cleared);

  await rp.evaluate(panel, `(() => {
    const strip = document.querySelector("#attachments-strip");
    strip.hidden = false;
    const tile = document.createElement("div");
    tile.className = "tile-56";
    tile.id = "expand-probe-tile";
    strip.append(tile);
    return true;
  })()`);
  await blurComposer(panel);
  await sleep(350);
  const withTile = await view(panel);
  await rp.screenshot(panel, join(out, "04b-tile.png"));
  check("有附件失焦：工具还开着", withTile.toolsOpen && withTile.attachClickable && withTile.sendShown && !withTile.inert, withTile);
  await rp.evaluate(panel, `(() => {
    document.querySelector("#expand-probe-tile")?.remove();
    document.querySelector("#attachments-strip").hidden = true;
    return true;
  })()`);
  await blurComposer(panel);
  await sleep(350);
  const tileGone = await view(panel);
  check("去掉附件：工具收回", !tileGone.toolsOpen && !tileGone.attachClickable && tileGone.sendShown, tileGone);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "这页讲了什么？");
  await rp.pressEnter(panel);
  const erred = await until(async () => {
    const now = await view(panel);
    return now.errorCard ? now : undefined;
  }, 30_000, "没连模型时的卡片");
  await sleep(300);
  await rp.screenshot(panel, join(out, "05-error.png"));
  await rp.click(panel, "#input");
  await sleep(400);
  const afterError = await view(panel);
  check("出错后点进去：工具还能展开", erred.errorCard && afterError.toolsOpen && afterError.sendShown, afterError);
  await blurComposer(panel);
  await sleep(350);
  const errorBlur = await view(panel);
  check("出错后失焦：工具收回", !errorBlur.toolsOpen && !errorBlur.attachClickable && errorBlur.sendShown && errorBlur.inert, errorBlur);

  await rp.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  }, panel);
  await sleep(300);
  await rp.evaluate(panel, `document.querySelector("#input").value=""; document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#input").blur(); true`);
  await sleep(400);
  const narrowIdle = await view(panel);
  await rp.click(panel, "#input");
  await sleep(400);
  const narrowFocus = await view(panel);
  await rp.screenshot(panel, join(out, "06-narrow.png"));
  check("窄到 320：空着仍只留发送，点进去加号出来", !narrowIdle.toolsOpen && !narrowIdle.attachClickable && narrowIdle.sendShown && narrowFocus.toolsOpen && narrowFocus.sendShown && narrowFocus.width <= 340, { narrowIdle, narrowFocus });
} finally {
  await rp.close();
  site.close();
}

for (const [name, pass] of results) if (!pass) console.log(`FAIL ${name}`);
if (!results.length || results.some(([, pass]) => !pass)) process.exitCode = 1;
