/** ≤50 行：侧栏能不能看出用户不在看它（窗口在后台、焦点在别处），以及点过一次之后、没有新点击时能不能出声。用法：npx tsx scripts/probes/attention-cues-premise.mts [--headed] */
import { launchRealPath, sleep } from "../acceptance/real-path/harness.mts";

const headed = process.argv.includes("--headed");
const rp = await launchRealPath({ headed });
const rows: Record<string, unknown> = {};
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await sleep(1500);
  const look = () => rp.evaluate(panel, `Promise.all([chrome.windows.getCurrent(), chrome.windows.getLastFocused(), chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })]).then(([w, last, panels]) => ({ visibility: document.visibilityState, hasFocus: document.hasFocus(), windowFocused: w.focused, lastFocused: [last.id, last.focused], panelWindows: panels.map(p => [p.windowId, p.tabId]), thisWindow: w.id, everClicked: navigator.userActivation.hasBeenActive }))`);
  // 不带用户手势执行：建一个新 AudioContext，放一段正弦，读分析器的输出和时钟是否在走。
  const sound = () => rp.evaluate(panel, `(async () => {
    const c = new AudioContext(); const before = c.state;
    if (c.state !== "running") await Promise.race([c.resume(), new Promise(r => setTimeout(r, 800))]);
    const o = c.createOscillator(), a = c.createAnalyser(); o.connect(a); a.connect(c.destination); o.start();
    const t0 = c.currentTime; await new Promise(r => setTimeout(r, 400));
    const buf = new Float32Array(a.fftSize); a.getFloatTimeDomainData(buf);
    const out = { before, after: c.state, clockAdvancedS: +(c.currentTime - t0).toFixed(3), peak: +Math.max(...buf.map(Math.abs)).toFixed(3) }; await c.close(); return out;
  })()`);
  rows.fresh = { ...(await look()), sound: await sound() };
  await rp.click(panel, "textarea, body");
  rows.afterClick = await look();
  // 有窗口时不抢焦点：新窗口用 focused:false 建；用户此刻在别的应用里，本身就是“不在看”。
  await rp.evaluate(panel, `chrome.windows.create({ url: "about:blank", focused: ${!headed} }).then(() => true)`);
  await sleep(1000);
  rows.otherWindow = { ...(await look()), sound: await sound() };
  if (!headed) {
    await rp.evaluate(panel, `chrome.windows.getCurrent().then(w => chrome.windows.update(w.id, { focused: true })).then(() => true)`);
    await sleep(500);
    rows.backToPanelWindow = await look();
  }
} finally { await rp.close(); await rp.remove(); }
console.log(JSON.stringify({ headed, rows }, null, 1));
type Row = { windowFocused: boolean; hasFocus: boolean; sound?: { after: string; peak: number } };
const r = rows as Record<string, Row>;
const away = r.otherWindow && (!r.otherWindow.windowFocused || !r.otherWindow.hasFocus);
const plays = r.otherWindow?.sound?.after === "running" && r.otherWindow.sound.peak > 0.1;
console.log(away && plays ? "成立" : "不成立");
process.exit(away && plays ? 0 : 1);
