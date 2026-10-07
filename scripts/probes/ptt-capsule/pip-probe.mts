/**
 * 前提小实验（docs/evals/20261007-ptt-capsule.md「技术前提」）：胶囊能不能放进 Document PiP 小窗。
 * 成立要两条都成立：只按右 ⌥ 就能打开小窗；打开小窗的网页跳转后，小窗还在。
 *   npx tsx scripts/probes/ptt-capsule/pip-probe.mts   退出码 0 成立，1 不成立。
 */
import { createServer } from "node:http";
import { launchRealPath, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>${req.url}</title><body>page ${req.url}<script>
addEventListener("keydown", async () => { try { const w = await documentPictureInPicture.requestWindow({ width: 280, height: 60 }); w.document.body.textContent = "capsule"; window.pipState = "open"; } catch (e) { window.pipState = "error: " + e.message; } });
</script>`));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${siteAddress(site).port}`;
const rp = await launchRealPath();
const result: Record<string, unknown> = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "tab");
  const s = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, s);
  await rp.cdp.send("Page.navigate", { url: `${base}/a` }, s);
  await sleep(1000);
  const press = async (key: Record<string, unknown>) => { await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, s); await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, s); await sleep(1000); };
  // 1. 只按右 ⌥：浏览器认不认这是用户动作。
  await press({ key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 });
  result.afterAlt = await rp.evaluate(s, "window.pipState ?? 'none'");
  // 2. 按字母键打开小窗，再让网页跳转：小窗（about:blank 目标）还在不在。
  await press({ key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
  result.afterLetter = await rp.evaluate(s, "window.pipState ?? 'none'");
  const pipOpen = async () => (await rp.targets()).some(t => t.type === "page" && t.url === "about:blank");
  result.pipBeforeNavigate = await pipOpen();
  await rp.cdp.send("Page.navigate", { url: `${base}/b` }, s);
  await sleep(1500);
  result.pipAfterNavigate = await pipOpen();
} finally { await rp.close(); await rp.remove(); site.close(); }

const holds = result.afterAlt === "open" && result.pipAfterNavigate === true;
console.log(JSON.stringify({ holds, ...result }));
process.exitCode = holds ? 0 : 1;
