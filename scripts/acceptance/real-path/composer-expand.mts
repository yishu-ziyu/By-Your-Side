/**
 * 输入框下面的工具行（加号、模型开关、话筒、语音、发送）一直显示：空着、没点进去时也在。只装扩展，脚本模型不需要，无头。
 *
 *   npx tsx scripts/acceptance/real-path/composer-expand.mts --headless
 *
 * 失败方式：打开侧栏不点任何地方就看不到或点不到加号、模型开关；点进空框时输入框高度跳动；按住工具行空白时焦点没进输入框或工具闪一下；
 * 打完字失焦、清空、去掉附件、点发送后、出错后失焦，工具收起来；窄到 320 发送键不见或页面横向溢出。
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

// 工具要让读屏也读得到：查 Chrome 自己的无障碍树，不看 DOM 属性。
const toolsInAx = async (panel: string) => {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel);
  const shown: string[] = [];
  for (const selector of ["#attach-btn", "#think-chip", ".voice-start"]) {
    const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, panel);
    if (!nodeId) throw new Error(`工具行里找不到 ${selector}，无障碍检查不能当作通过`);
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

const view = async (panel: string) => ({ ...await rp.evaluate(panel, `(() => {
  const inner = document.querySelector("#composer-bar-inner");
  const send = document.querySelector("#send-btn");
  const ics = inner ? getComputedStyle(inner) : null;
  const scs = send ? getComputedStyle(send) : null;
  const innerBox = inner?.getBoundingClientRect();
  const sendBox = send?.getBoundingClientRect();
  const hit = (sel) => {
    const el = document.querySelector(sel);
    const box = el?.getBoundingClientRect();
    const at = box && box.width > 0 ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return !!(el && at && el.contains(at));
  };
  const root = document.documentElement;
  return {
    toolsShown: !!(ics && ics.visibility === "visible" && +ics.opacity > 0.5 && (innerBox?.height ?? 0) > 8),
    attachClickable: hit("#attach-btn"),
    thinkClickable: hit("#think-chip"),
    sendShown: !!(send && scs && scs.display !== "none" && scs.visibility !== "hidden" && (sendBox?.width ?? 0) > 8 && (sendBox?.right ?? Infinity) <= root.clientWidth),
    sendClickable: hit("#send-btn"),
    composerHeight: Math.round((document.querySelector("#composer")?.getBoundingClientRect().height ?? 0) * 10) / 10,
    starter: (() => {
      const el = document.querySelector("#starter-connect");
      if (!el) return false;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && box.width > 8 && box.height > 8;
    })(),
    starterTitle: document.querySelector("#starter-title")?.textContent ?? "",
    errorCard: [...document.querySelectorAll(".needs-model-card,.receipt-decision,.msg.error")].some((el) => (el.textContent ?? "").trim().length > 0),
    width: root.clientWidth,
    overflowX: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
  };
})()`) as {
  toolsShown: boolean;
  attachClickable: boolean;
  thinkClickable: boolean;
  sendShown: boolean;
  sendClickable: boolean;
  composerHeight: number;
  starter: boolean;
  starterTitle: string;
  errorCard: boolean;
  width: number;
  overflowX: number;
}, inAx: await toolsInAx(panel) });

type View = Awaited<ReturnType<typeof view>>;
const rowShown = (v: View) => v.toolsShown && v.attachClickable && v.sendShown && v.inAx.includes("#attach-btn");

try {
  const tab = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "网页");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, await rp.attach(tab.targetId));
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn") && document.readyState==="complete"`)) || undefined, 30_000, "侧栏就绪");
  await until(async () => (await view(panel)).starter || undefined, 20_000, "空侧栏出现连模型");
  await sleep(400);

  // 没连模型时模型开关本来就藏着；这里当作已知模型，把它放出来再看它在不在工具行里。
  await rp.evaluate(panel, `document.querySelector("#think-chip").hidden = false; true`);
  await sleep(100);
  const idle = await view(panel);
  await rp.screenshot(panel, join(out, "01-idle.png"));
  check("空着没点：加号、模型开关、发送键都看得到、点得到", rowShown(idle) && idle.thinkClickable && idle.sendClickable && idle.inAx.includes("#think-chip") && idle.inAx.includes(".voice-start"), idle);
  check("空着：还看得到先连接模型", idle.starter && idle.starterTitle.includes("先连接"), idle.starterTitle);

  await rp.click(panel, "#input");
  await sleep(450);
  const focused = await view(panel);
  await rp.screenshot(panel, join(out, "02-focus.png"));
  check("点进空框：输入框高度不跳，工具还在", rowShown(focused) && Math.abs(focused.composerHeight - idle.composerHeight) <= 1, { before: idle.composerHeight, after: focused.composerHeight, focused });
  await rp.click(panel, "#attach-btn");
  await sleep(350);
  const menuOpen = await rp.evaluate(panel, `!document.querySelector("#attach-menu")?.hidden`);
  await rp.click(panel, "#attach-btn");
  await sleep(250);
  check("加号能打开附件菜单", menuOpen === true, { menuOpen });
  await blurComposer(panel);
  await sleep(350);

  const spacer = await barSpot(panel, "#composer-spacer", "r.width / 2");
  const beforePress = await view(panel);
  await mouse(panel, "mouseMoved", spacer);
  await mouse(panel, "mousePressed", spacer);
  await sleep(200);
  const pressing = await view(panel);
  const pressFocus = await rp.evaluate(panel, `document.activeElement?.id ?? ""`);
  await rp.screenshot(panel, join(out, "02b-press.png"));
  await mouse(panel, "mouseReleased", spacer);
  await sleep(200);
  const released = await view(panel);
  check("按住工具行空白：焦点进输入框，工具不闪",
    rowShown(beforePress) && rowShown(pressing) && rowShown(released) && pressFocus === "input"
      && Math.abs(pressing.composerHeight - beforePress.composerHeight) <= 1 && Math.abs(released.composerHeight - beforePress.composerHeight) <= 1,
    { pressFocus, before: beforePress.composerHeight, pressing: pressing.composerHeight, released: released.composerHeight });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "整理这一页");
  await blurComposer(panel);
  await sleep(450);
  const typed = await view(panel);
  await rp.screenshot(panel, join(out, "03-has-text.png"));
  check("有字失焦：工具还在", rowShown(typed), typed);

  await rp.evaluate(panel, `document.querySelector("#input").value=""; document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("#input").blur(); true`);
  await sleep(450);
  const cleared = await view(panel);
  check("清空后：工具还在", rowShown(cleared), cleared);

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
  await rp.screenshot(panel, join(out, "04-tile.png"));
  await rp.click(panel, "#attachments-strip .tile-dismiss-btn");
  await until(async () => (await rp.evaluate(panel, `!document.querySelector("#attachments-strip .tile-56")`)) || undefined, 5_000, "附件去掉");
  await blurComposer(panel);
  await sleep(350);
  const tileGone = await view(panel);
  check("有附件、去掉附件后失焦：工具都还在", rowShown(withTile) && rowShown(tileGone), { withTile, tileGone });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "这页讲了什么？");
  await rp.click(panel, "#send-btn");
  await sleep(400);
  const afterSend = await view(panel);
  const sendFocus = await rp.evaluate(panel, `document.activeElement?.id ?? ""`);
  await rp.screenshot(panel, join(out, "05-send.png"));
  check("点发送后空框：工具还在", rowShown(afterSend), { ...afterSend, sendFocus });
  const erred = await until(async () => {
    const now = await view(panel);
    return now.errorCard ? now : undefined;
  }, 30_000, "没连模型时的卡片");
  await sleep(300);
  await blurComposer(panel);
  await sleep(350);
  const errorBlur = await view(panel);
  await rp.screenshot(panel, join(out, "06-error.png"));
  check("出错后失焦：工具还在", erred.errorCard && rowShown(errorBlur), errorBlur);

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
  await rp.screenshot(panel, join(out, "07-narrow.png"));
  check("窄到 320：空着工具和发送键都在，不横向溢出", rowShown(narrowIdle) && narrowIdle.sendClickable && narrowIdle.width <= 340 && narrowIdle.overflowX <= 0, narrowIdle);
} finally {
  await rp.close();
  site.close();
}

for (const [name, pass] of results) if (!pass) console.log(`FAIL ${name}`);
if (!results.length || results.some(([, pass]) => !pass)) process.exitCode = 1;
