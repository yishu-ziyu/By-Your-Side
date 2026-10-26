/** Real model + real public Wikipedia. Requires an existing ChatGPT login; never included in the credential-free suite. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-learned-operations-live`);
await mkdir(out, { recursive: true });
const plan = await loadModelPlan(process.argv.find(arg => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL).catch((error: unknown) => ({ error }));
if ("error" in plan) {
  const reason = `真实模型登录不可用：${String(plan.error)}`;
  await writeFile(join(out, "result.json"), JSON.stringify({ status: "NOT_RUN", reason }, null, 2));
  console.log(`没跑：${reason}\n证据：${out}`);
  process.exitCode = 2;
} else {
  const rp = await launchRealPath();
  const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
  const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
  let panel = "";
  let work = "";
  const idle = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  const send = async (text: string) => {
    const before = await rp.evaluate(panel, 'document.querySelectorAll(".msg.assistant").length') as number;
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => {
      const state = await rp.evaluate(panel, `({count:document.querySelectorAll(".msg.assistant").length,check:[...document.querySelectorAll(".run-check")].at(-1)?.textContent??"",idle:${idle},text:document.querySelector("#messages")?.textContent??""})`) as { count: number; check: string; idle: boolean; text: string };
      if (state.check.includes("没做成")) throw new Error(`目标核对未完成：${state.check}\n${state.text.slice(-1_500)}`);
      return state.count > before && state.idle && state.check.includes("已核对页面") || undefined;
    }, 240_000, `真实模型完成并核对：${text}`);
  };
  const readOperations = async () => rp.evaluate(panel, `new Promise((resolve,reject)=>{const req=indexedDB.open("sideagent-memory");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction("kv").objectStore("kv").get("learned-operations");get.onerror=()=>reject(get.error);get.onsuccess=()=>{const raw=get.result;db.close();resolve(typeof raw==="string"?JSON.parse(raw):null)}}})`);
  try {
    work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
    await rp.cdp.send("Page.navigate", { url: "https://zh.wikipedia.org/" }, work);
    panel = await rp.attach(await rp.openSidePanel());
    const settings = modelStorageItems(plan);
    settings.inproc_fast_model_config = settings.inproc_model_config;
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(settings)}).then(()=>true)`);
    await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
    await send("在中文维基百科搜索故宫，列出前 3 个结果的标题");
    await send("把刚才搜索维基百科结果的做法记住");
    const stored = await readOperations() as { operations?: Array<Record<string, unknown>> } | null;
    const operation = stored?.operations?.[0];
    check("真实模型生成并保存一个做法", stored?.operations?.length === 1 && typeof operation?.code === "string" && !operation.code.includes("故宫"), { count: stored?.operations?.length ?? 0, operation: operation ? { id: operation.id, name: operation.name, site: operation.site, stats: operation.stats } : null });
    await rp.screenshot(panel, join(out, "saved.png"));

    await send("换成长城，再列出前 3 个结果标题");
    const reused = await readOperations() as { operations?: Array<Record<string, unknown>> } | null;
    const stats = reused?.operations?.[0]?.stats as { successes?: number; failures?: number } | undefined;
    const page = await rp.evaluate(work, "({url:location.href,text:document.body.innerText.slice(0,12000)})") as { url: string; text: string };
    const answer = await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent??""') as string;
    check("真实模型换查询词复用并读到新结果", Number(stats?.successes ?? 0) >= 1 && /search=.*长城|长城.*search=/.test(page.url) && page.text.includes("长城") && answer.includes("长城"), { stats, url: page.url, answer: answer.slice(0, 800), pageContains: page.text.includes("长城") });
    await rp.screenshot(panel, join(out, "reused.png"));
  } catch (error) {
    check("真实模型公开网站流程", false, String(error));
    if (panel) {
      await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
      await writeFile(join(out, "failure.txt"), String(await rp.evaluate(panel, "document.body.innerText").catch(String)));
    }
  } finally {
    const stored = panel ? await readOperations().catch(() => null) : null;
    await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(item => item.pass) ? "PASS" : "FAIL", checks, operations: stored }, null, 2));
    await rp.close();
    await rp.remove();
  }
  console.log(`证据：${out}`);
  if (!checks.length || checks.some(item => !item.pass)) process.exitCode = 1;
}
