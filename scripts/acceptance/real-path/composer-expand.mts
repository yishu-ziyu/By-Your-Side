/**
 * 输入框空着只留字和发送；点进去、有字、有附件时工具行才展开。只装扩展，脚本模型不需要，无头。
 *
 *   npx tsx scripts/acceptance/real-path/composer-expand.mts --headless
 *
 * 失败方式：空着就露出加号；点发送后空框加号还在；点进去加号不出现；打完字失焦后工具收回；窄到 320 发送键不见；
 * 按住工具行空白时工具先收起再展开；收起没有过渡；少动效设置下展开仍然弹。
 */
import { mkdir, writeFile } from "node:fs/promises";
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

// 收起的工具不该被读屏读到：查 Chrome 自己的无障碍树，不看 DOM 属性。
const toolsInAx = async (panel: string) => {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel);
  const shown: string[] = [];
  for (const selector of ["#attach-btn", "#think-chip"]) {
    const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, panel);
    if (!nodeId) continue;
    const { nodes } = await rp.cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false }, panel);
    if (nodes[0] && !nodes[0].ignored) shown.push(selector);
  }
  return shown;
};

const mouse = (panel: string, type: "mouseMoved" | "mousePressed" | "mouseReleased", at: { x: number; y: number }) =>
  rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) }, panel);

const barSpot = (panel: string, selector: string, dx: string) => rp.evaluate(panel, `(() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: r.left + ${dx}, y: r.top + r.height / 2 };
})()`) as Promise<{ x: number; y: number }>;

const sampleAfter = (panel: string, action: string, ms: number) => rp.evaluate(panel, `new Promise((done) => {
  ${action};
  setTimeout(() => {
    const cs = getComputedStyle(document.querySelector("#composer-bar-inner"));
    done({ visibility: cs.visibility, opacity: +cs.opacity, transform: cs.transform, properties: cs.transitionProperty, durations: cs.transitionDuration.split(",").map(parseFloat) });
  }, ${ms});
})`) as Promise<{ visibility: string; opacity: number; transform: string; properties: string; durations: number[] }>;

const view = async (panel: string) => ({ ...await rp.evaluate(panel, `(() => {
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
    sendShown: !!(send && scs && scs.display !== "none" && (sendBox?.width ?? 0) > 8),
    starter: (() => {
      const el = document.querySelector("#starter-connect");
      if (!el) return false;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && box.width > 8 && box.height > 8;
    })(),
    starterTitle: document.querySelector("#starter-title")?.textContent ?? "",
    errorCard: [...document.querySelectorAll(".needs-model-card,.receipt-decision,.msg.error")].some((el) => (el.textContent ?? "").trim().length > 0),
    width: document.documentElement.clientWidth,
  };
})()`) as {
  toolsOpen: boolean;
  attachClickable: boolean;
  thinkClickable: boolean;
  sendShown: boolean;
  starter: boolean;
  starterTitle: string;
  errorCard: boolean;
  width: number;
}, inAx: await toolsInAx(panel) });

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
  check("空着：加号收起，发送键在", !idle.toolsOpen && !idle.attachClickable && !idle.thinkClickable && !idle.inAx.length && idle.sendShown && idle.starter, idle);
  check("空着：还看得到先连接模型", idle.starter && idle.starterTitle.includes("先连接"), idle.starterTitle);

  const emptyBar = await barSpot(panel, "#composer-bar", "20");
  await mouse(panel, "mouseMoved", emptyBar);
  await mouse(panel, "mousePressed", emptyBar);
  await mouse(panel, "mouseReleased", emptyBar);
  await sleep(350);
  const fromBar = await view(panel);
  check("点发送键左边空白：工具展开", fromBar.toolsOpen && fromBar.attachClickable && fromBar.sendShown && fromBar.inAx.includes("#attach-btn"), fromBar);

  const spacer = await barSpot(panel, "#composer-spacer", "r.width / 2");
  await mouse(panel, "mouseMoved", spacer);
  await mouse(panel, "mousePressed", spacer);
  await sleep(200);
  const pressing = await view(panel);
  const pressFocus = await rp.evaluate(panel, `document.activeElement?.id ?? ""`);
  await rp.screenshot(panel, join(out, "01b-press.png"));
  await mouse(panel, "mouseReleased", spacer);
  await sleep(200);
  const released = await view(panel);
  check("空框按住工具行空白：工具不先收起", pressing.toolsOpen && pressFocus === "input" && released.toolsOpen, { pressing, pressFocus, released });
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

  const leaving = await sampleAfter(panel, `document.activeElement?.blur()`, 60);
  check("空着失焦：收起有淡出，不是一下消失", leaving.visibility === "visible" && leaving.opacity > 0.05 && leaving.opacity < 1, leaving);
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

  // 和在系统文件框里选好图一样：文件交给附件菜单背后的那个文件框。
  const image = join(out, "attach.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel);
  const { nodeId: fileInput } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" }, panel);
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId: fileInput, files: [image] }, panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#attachments-strip .tile-56")`)) || undefined, 10_000, "附件出现");
  await blurComposer(panel);
  await sleep(500);
  const withTile = await view(panel);
  await rp.screenshot(panel, join(out, "04b-tile.png"));
  check("有附件失焦：工具还开着", withTile.toolsOpen && withTile.attachClickable && withTile.sendShown && withTile.inAx.includes("#attach-btn"), withTile);
  await rp.click(panel, "#attachments-strip .tile-dismiss-btn");
  await until(async () => (await rp.evaluate(panel, `!document.querySelector("#attachments-strip .tile-56")`)) || undefined, 5_000, "附件去掉");
  await blurComposer(panel);
  await sleep(350);
  const tileGone = await view(panel);
  check("去掉附件：工具收回", !tileGone.toolsOpen && !tileGone.attachClickable && tileGone.sendShown, tileGone);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "这页讲了什么？");
  await rp.click(panel, "#send-btn");
  await sleep(400);
  const afterSend = await view(panel);
  const sendFocus = await rp.evaluate(panel, `document.activeElement?.id ?? ""`);
  await rp.screenshot(panel, join(out, "04c-send.png"));
  check("点发送后空框：工具收回", !afterSend.toolsOpen && !afterSend.attachClickable && afterSend.sendShown && !afterSend.inAx.length, { ...afterSend, sendFocus });
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
  check("出错后失焦：工具收回", !errorBlur.toolsOpen && !errorBlur.attachClickable && errorBlur.sendShown && !errorBlur.inAx.length, errorBlur);

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

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await blurComposer(panel);
  await sleep(400);
  const opening = await sampleAfter(panel, `document.querySelector("#input").focus()`, 50);
  await sleep(300);
  const reducedOpen = await view(panel);
  check("少动效：展开不位移、不弹，时长不超过 0.14 秒", opening.transform === "none" && !opening.properties.includes("transform") && Math.max(...opening.durations) <= 0.14 && reducedOpen.toolsOpen, { opening, toolsOpen: reducedOpen.toolsOpen });
} finally {
  await rp.close();
  site.close();
}

for (const [name, pass] of results) if (!pass) console.log(`FAIL ${name}`);
if (!results.length || results.some(([, pass]) => !pass)) process.exitCode = 1;
