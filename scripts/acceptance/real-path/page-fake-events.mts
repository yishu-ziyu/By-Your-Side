import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-fake-events`);

await mkdir(out, { recursive: true });

const wav = join(out, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", "[[slnc 200]]测试一下[[slnc 400]]"]);

const hits = new Map<string, number>();

const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;

  if (path !== "/") hits.set(path, (hits.get(path) ?? 0) + 1);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(path === "/"
    ? `<!doctype html><title>伪造事件</title><body style="font:18px system-ui;padding:40px">
<p id="para">这一段文字用来测试划词工具条，网页脚本选中它以后不该弹出工具条。</p>
<p id="word">工具条对照用的一段话，用户真的双击选中其中一个词。</p>
<p><a id="real" href="/real-target">真实悬停的链接</a></p>
<p><a id="fake-hover" href="/fake-hover-target">伪造悬停的链接</a></p>
<p><a id="fake-shift" href="/fake-shift-target">真悬停、伪造 Shift 的链接</a></p>`
    : `<!doctype html><title>目标页</title><p>目标页正文，足够长的一段话，让预览有东西可取。</p>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const HOST = "fake-events.test";
const base = `http://${HOST}:${siteAddress(site).port}`;

const rp = await launchRealPath({ microphoneWav: wav, chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type DomNode = { nodeName?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

try {
  const work = (await rp.targets()).find(t => t.url === "about:blank")!;
  const page = await rp.attach(work.targetId);
  await rp.cdp.send("Page.navigate", { url: `${base}/` }, page);
  await until(async () => await rp.evaluate(page, `!!document.querySelector("[data-sideagent-ask]") && !!document.querySelector("#fake-shift")`) || undefined, 20_000, "页面脚本装好");

  const capsule = () => rp.evaluate(page, `document.querySelector('[data-sideagent-overlay="ptt-capsule"]')?.dataset.phase ?? null`) as Promise<string | null>;

  const phasesDuring = async (ms: number) => {
    const seen: string[] = [];

    for (let at = 0; at < ms; at += 150) { await sleep(150); const phase = await capsule(); if (phase && seen.at(-1) !== phase) seen.push(phase); }

    return seen;
  };

  const toolbarShown = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };
    const find = (node: DomNode, test: (n: DomNode) => boolean): DomNode | null => test(node) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].reduce<DomNode | null>((hit, child) => hit ?? find(child, test), null);
    const host = find(root, n => !!n.attributes?.includes("data-sideagent-ask"));
    const surface = host ? find(host, n => n.nodeName === "SECTION" && (n.attributes ?? []).some(a => a.split(/\s+/).includes("surface"))) : null;

    return !!surface && !surface.attributes?.includes("hidden");
  };

  const previewShown = async () => {
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };
    const find = (node: DomNode): DomNode | null => node.nodeName === "DIV" && (node.attributes ?? []).includes("tooltip") && (node.attributes ?? []).some(a => a.split(/\s+/).includes("card")) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].reduce<DomNode | null>((hit, child) => hit ?? find(child), null);
    const card = find(root);

    return !!card && !card.attributes?.includes("hidden");
  };

  const focusOnCard = async () => await rp.evaluate(page, `!!document.activeElement?.hasAttribute?.("data-sideagent-ask")`) as boolean;
  const key = (type: string, k: { key: string; code: string; windowsVirtualKeyCode: number; location?: number; text?: string }, modifiers = 0) => rp.cdp.send("Input.dispatchKeyEvent", { type, modifiers, ...k }, page);
  const alt = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const escape = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
  const shiftKey = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
  const letter = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" };
  const center = async (selector: string) => await rp.evaluate(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number };
  const mouse = (type: string, at: { x: number; y: number }, extra: Record<string, unknown> = {}) => rp.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, ...extra }, page);
  const corner = { x: 5, y: 5 };

  await rp.evaluate(page, `(() => { const o = { key: "Alt", code: "AltRight", location: 2, bubbles: true }; dispatchEvent(new KeyboardEvent("keydown", o)); setTimeout(() => dispatchEvent(new KeyboardEvent("keyup", o)), 600); return true; })()`);
  const fakePress = await phasesDuring(1_800);
  check("a 网页伪造右 ⌥ 不出现胶囊", fakePress.length === 0, { phases: fakePress });

  await key("rawKeyDown", alt);
  const realPhase = await until(async () => await capsule(), 3_000, "真按右 ⌥ 后胶囊出现").catch(() => null);
  check("a 对照：真按右 ⌥ 出现按住说话的胶囊", realPhase === "listening", { realPhase });
  await rp.evaluate(page, `(() => { dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltRight", location: 2, bubbles: true })); dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); dispatchEvent(new Event("blur")); return true; })()`);
  const duringFake = await phasesDuring(900);
  check("a 真按住时，网页伪造的松开、Esc、失焦不打断录音", duringFake.length > 0 && duringFake.every(p => p === "listening"), { phases: duringFake });

  await key("rawKeyDown", escape);
  await key("keyUp", escape);
  await key("keyUp", alt);
  const cancelled = await until(async () => (await capsule()) === null || undefined, 5_000, "真 Esc 取消后胶囊收起").then(() => true, () => false);
  check("a 真按 Esc 取消录音，胶囊收起", cancelled, { phase: await capsule() });
  await sleep(500);
  await key("rawKeyDown", alt);
  const again = await until(async () => await capsule(), 3_000, "取消后再按，胶囊又出现").catch(() => null);
  await sleep(600);
  await key("keyUp", alt);
  const afterRelease = await phasesDuring(2_000);
  check("a 取消后再按能录，真松开后不再停在「在听」", again === "listening" && afterRelease.length > 0 && afterRelease.at(-1) !== "listening", { again, afterRelease });

  await mouse("mouseMoved", corner);
  await key("rawKeyDown", shiftKey, 8);
  await mouse("mouseMoved", await center("#real"), { modifiers: 8 });
  await sleep(1_500);
  const realCard = await previewShown();
  await key("keyUp", shiftKey);
  await mouse("mouseMoved", corner);
  check("b 真按 Shift 悬停不弹预览、不发请求", !realCard && (hits.get("/real-target") ?? 0) === 0, { realCard, hits: hits.get("/real-target") ?? 0 });
  await until(async () => !(await previewShown()) || undefined, 3_000, "松开 Shift 后预览卡收起").catch(() => null);

  await rp.evaluate(page, `(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })); document.querySelector("#fake-hover").dispatchEvent(new PointerEvent("pointerover", { bubbles: true, shiftKey: true })); return true; })()`);
  await sleep(1_500);
  const fakeHoverCard = await previewShown();
  check("b 网页伪造 Shift 悬停，扩展不弹预览、不替它发请求", !fakeHoverCard && (hits.get("/fake-hover-target") ?? 0) === 0, { card: fakeHoverCard, hits: hits.get("/fake-hover-target") ?? 0 });

  await mouse("mouseMoved", await center("#fake-shift"));
  await sleep(300);
  await rp.evaluate(page, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true })), true`);
  await sleep(1_500);
  const fakeShiftCard = await previewShown();
  await mouse("mouseMoved", corner);
  check("b 用户真悬停时网页伪造 Shift，扩展不弹预览、不替它发请求", !fakeShiftCard && (hits.get("/fake-shift-target") ?? 0) === 0, { card: fakeShiftCard, hits: hits.get("/fake-shift-target") ?? 0 });

  const fakeSelect = (then: string) => rp.evaluate(page, `(() => { const p = document.querySelector("#para"); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); ${then}; return true; })()`);
  await fakeSelect(`p.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
  await sleep(800);
  const barAfterPointer = await toolbarShown();
  await fakeSelect(`document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", bubbles: true }))`);
  await sleep(800);
  const barAfterKey = await toolbarShown();
  check("c 网页伪造选字（松开指针或 Shift）不弹划词工具条", !barAfterPointer && !barAfterKey, { barAfterPointer, barAfterKey });
  await rp.evaluate(page, `getSelection().removeAllRanges(), true`);

  const span = await rp.evaluate(page, `(() => { const r = document.querySelector("#word").getBoundingClientRect(); return { y: r.y + r.height / 2, from: r.x + 2, to: r.right - 2 }; })()`) as { y: number; from: number; to: number };
  await mouse("mouseMoved", { x: span.from, y: span.y });
  await mouse("mousePressed", { x: span.from, y: span.y }, { button: "left", clickCount: 1 });
  for (let x = span.from; x <= span.to; x += Math.max(20, (span.to - span.from) / 8)) await mouse("mouseMoved", { x, y: span.y }, { button: "left", buttons: 1 });
  await mouse("mouseMoved", { x: span.to, y: span.y }, { button: "left", buttons: 1 });
  await mouse("mouseReleased", { x: span.to, y: span.y }, { button: "left", clickCount: 1 });
  const realBar = await until(async () => await toolbarShown() || undefined, 3_000, "真选字后工具条出现").catch(() => false);
  check("c 对照：真选中文字，弹出划词工具条", realBar === true, { realBar });

  await rp.evaluate(page, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true })), true`);
  await sleep(500);
  const fakeTyping = { stillShown: await toolbarShown(), focus: await focusOnCard() };
  check("c 工具条开着时网页伪造字母键，不抢焦点", fakeTyping.stillShown && !fakeTyping.focus, fakeTyping);
  await key("keyDown", letter);
  await key("keyUp", letter);
  const realFocus = await until(async () => await focusOnCard() || undefined, 2_000, "真按字母键后焦点进入工具条").catch(() => false);
  check("c 对照：真按字母键，焦点进入工具条的输入框", realFocus === true, { realFocus });
  await rp.screenshot(page, join(out, "page.png"));
  await key("rawKeyDown", escape);
  await key("keyUp", escape);
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, hits: Object.fromEntries(hits) }, null, 2));
  await rp.close(); await rp.remove();
  site.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
