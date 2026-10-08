/**
 * 用真侧栏和脚本模型写 HTML 文件，测试真实沙箱交互；不产生真实模型费用。
 * npx tsx scripts/acceptance/real-path/visual-ui-artifact.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/visual-ui-production/real-extension");
await mkdir(out, { recursive: true });
const source = '<!doctype html><meta charset="utf-8"><input id="memo" placeholder="我的选择备注"><button id="choice" onclick="parent.postMessage({sideagentResultChoice:1,label:&quot;路线 B&quot;},&quot;*&quot;)">选路线 B</button>';
// Two different interactive cards remain open while the next turn edits A only.
const multiHtml = (id: "A" | "B") => `<!doctype html><meta charset="utf-8">
<body data-version="v1"><input id="memo" placeholder="${id}"><script>
window.__instance = Math.random().toString(36).slice(2);
addEventListener("message", e => {
  if (e.data?.probe !== "${id}") return;
  if (typeof e.data.set === "string") document.querySelector("#memo").value = e.data.set;
  parent.postMessage({probeResult: "${id}", nonce: e.data.nonce, instance: window.__instance,
    text: document.querySelector("#memo").value, version: document.body.dataset.version}, "*");
});
</script>`;
const model = await startScriptedModel([
  { match: "做一个互动结果卡", steps: [
    {tool: {name:"artifacts", args:{command:"create",filename:"interactive-result.html",content:source}}},
    {text:"互动卡已生成，请主动打开交互预览。",delayMs:9000}
  ]},
  { match: "创建两张交互卡", steps: [
    {tool:{name:"artifacts",args:{command:"create",filename:"card-A.html",content:multiHtml("A")}}},
    {tool:{name:"artifacts",args:{command:"create",filename:"card-B.html",content:multiHtml("B")}}},
    {text:"两张卡片已生成，本轮完成。"}
  ]},
  { match: "只修改卡片 A", steps: [
    {tool:{name:"artifacts",args:{command:"update",filename:"card-A.html",old_str:'data-version="v1"',new_str:'data-version="v2"'}}},
    {text:"本轮只改了 A，没有修改 B。"}
  ]}
]);
const site = createServer((_req,res) => res.writeHead(200, {"content-type":"text/html;charset=utf-8"}).end("<!doctype html><title>结果卡场景</title>"));
await new Promise<void>(resolve => site.listen(0,"127.0.0.1",resolve));
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
try {
  rp = await launchRealPath();
  const blank = await until(async () => (await rp!.targets()).find(t=>t.type==="page" && t.url==="about:blank"), 10_000, "初始页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate",{url:"http://127.0.0.1:"+siteAddress(site).port+"/"},page);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled",{enabled:true},panel);
  await rp.evaluate(panel,'window.__sandboxDebug=[];window.addEventListener("message",e=>window.__sandboxDebug.push({origin:e.origin,data:e.data}));true');
  const config = await configureViaSettings(rp,panel,{providerId:"custom",modelId:"demo-model",credential:{type:"api_key",key:"local-demo-no-secret"}},{baseUrl:model.baseUrl});
  await rp.cdp.send("Target.closeTarget",{targetId:config.settingsTargetId});
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false') || undefined,70_000,"侧栏就绪");
  await rp.click(panel,"#input");
  await rp.typeText(panel,"做一个互动结果卡");
  await rp.pressEnter(panel);
  const card = '.artifact-card[data-filename="interactive-result.html"]';
  await until(async()=>await rp!.evaluate(panel,`!!document.querySelector(${JSON.stringify(card+" .artifact-inline-toggle:not([hidden])")})`) || undefined, 60_000,"结果 HTML 文件卡");
  assert.equal(await rp.evaluate(panel,'document.querySelector("#messages")?.textContent.includes("互动卡已生成，请主动打开交互预览。")'),false,
    "必须在助手继续写回答时展开，而不是结束后再测");
  assert.equal(await rp.evaluate(panel, `document.querySelector(${JSON.stringify(card+" .artifact-inline-frame")}) === null`),true,"默认不执行沙箱");
  await rp.click(panel,card+" .artifact-inline-toggle");
  const frame = card+" .artifact-inline-frame";
  const metadata = await rp.evaluate(panel,`(()=>{const f=document.querySelector(${JSON.stringify(frame)});return {sandbox:f?.getAttribute("sandbox"),src:f?.getAttribute("src"),choice:document.querySelector(${JSON.stringify(card+" .artifact-inline-feedback")})?.hidden===false};})()`) as {sandbox:string;src:string;choice:boolean};
  assert.equal(metadata.sandbox,"allow-scripts");
  assert.equal(metadata.src?.endsWith("/artifact-sandbox.html"),true);
  assert.equal(metadata.choice,false);
  // 真 Chrome 扩展中的沙箱可能成为跨进程 iframe target；优先用对应 target，否则隔离执行上下文。
  const inside = async(expression:string) => {
    const frameTarget = (await rp!.targets()).find(t=>t.type==="iframe"&&t.url.includes("/artifact-sandbox.html"));

    if(frameTarget) return rp!.evaluate(await rp!.attach(frameTarget.targetId),expression);
    const tree = await rp!.cdp.send("Page.getFrameTree",{},panel) as {frameTree:{childFrames?:Array<{frame:{id:string;url:string}}> }};
    const child = tree.frameTree.childFrames?.find(f=>f.frame.url.includes("/artifact-sandbox.html"));
    if(!child) throw new Error("未找到扩展侧栏的沙箱 iframe");
    const {executionContextId} = await rp!.cdp.send("Page.createIsolatedWorld",{frameId:child.frame.id,worldName:"sideagent-check"},panel);
    const response = await rp!.cdp.send("Runtime.evaluate",{expression,contextId:executionContextId,returnByValue:true,awaitPromise:true},panel);
    if(response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
  };
  await until(async()=>await inside('!!document.querySelector("#choice")').catch(()=>false) || undefined,12_000,"沙箱交互加载");
  const secrets = await inside('({parent:(()=>{try{return parent.document.title}catch(e){return e.name}})(),origin:location.origin,chrome:typeof chrome,chromeKeys:typeof chrome!=="undefined"?Object.keys(chrome):[],runtime:typeof chrome?.runtime,extensionId:chrome?.runtime?.id??null,storage:typeof chrome?.storage?.local})') as {parent:string;chrome:string;origin:string;chromeKeys:string[];runtime:string;extensionId:string|null;storage:string};
  console.log("SANDBOX_BOUNDARY",JSON.stringify(secrets));
  assert.equal(secrets.parent,"SecurityError");
  assert.equal(secrets.extensionId,null,"沙箱不能取得扩展 runtime ID");
  assert.equal(secrets.storage,"undefined","沙箱不能访问扩展存储");
  await inside('document.querySelector("#memo").value="用户填写过的备注";window.__previewCheckpoint="keep";true');
  await inside('document.querySelector("#choice").click();true');
  await until(async()=>await rp!.evaluate(panel,
    `document.querySelector(${JSON.stringify(card+" .artifact-inline-feedback")})?.hidden===false||undefined`),10_000,"选择待确认").catch(async (error)=>{
      console.log("SANDBOX_MESSAGES",await rp!.evaluate(panel,'window.__sandboxDebug'));
      throw error;
    });
  await until(async()=>await rp!.evaluate(panel,
    `document.querySelector(${JSON.stringify(card)})?.previousElementSibling?.textContent?.includes("互动卡已生成，请主动打开交互预览。")||undefined`),
    30_000,"回答完成且 HTML 卡片位于回答之后");
  const kept = await inside('({text:document.querySelector("#memo")?.value,checkpoint:window.__previewCheckpoint,selected:document.querySelector("#choice")!==null})');
  assert.deepEqual(kept,{text:"用户填写过的备注",checkpoint:"keep",selected:true},
    "回答结束重新排列卡片时，沙箱文档、组件状态和用户填写内容必须保持原样");
  assert.equal(await rp.evaluate(panel,
    `document.querySelector(${JSON.stringify(card+" .artifact-inline-feedback")})?.hidden`),false,
    "回传到侧栏的待确认选择必须保留");
  assert.equal(await rp.evaluate(panel,'document.querySelector("#input")?.value'),"","不能自动填、不能替用户发送");
  await rp.evaluate(panel,`document.querySelector(${JSON.stringify(card+" .artifact-apply-choice")})?.scrollIntoView({block:"center"});true`);
  await sleep(200);
  await rp.click(panel,card+" .artifact-apply-choice");
  assert.match(await rp.evaluate(panel,'document.querySelector("#input")?.value') as string,/我选择：路线 B/);
  await rp.screenshot(panel,join(out,"03-actual-sidepanel-interaction.png"));
  await rp.click(panel,card+" .artifact-inline-toggle");
  assert.equal(await rp.evaluate(panel,`document.querySelector(${JSON.stringify(frame)})===null`),true);
  // 第二个场景：A、B 已属于前一轮对话，下一轮只修改 A。
  const sendQuestion = async (message: string) => {
    await rp!.click(panel, "#input");
    await rp!.typeText(panel, message);
    await rp!.pressEnter(panel);
  };
  await rp.evaluate(panel,'document.querySelector("#input").value="";document.querySelector("#input").dispatchEvent(new Event("input",{bubbles:true}));true');
  await sendQuestion("创建两张交互卡");
  const a = '.artifact-card[data-filename="card-A.html"]';
  const b = '.artifact-card[data-filename="card-B.html"]';
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#messages")?.textContent.includes("两张卡片已生成，本轮完成。")||undefined'),60_000,"两张卡片首轮回答");
  await until(async()=>await rp!.evaluate(panel,`!!document.querySelector(${JSON.stringify(a)})&&!!document.querySelector(${JSON.stringify(b)})||undefined`),10_000,"A/B 卡片存在");
  for (const selector of [a, b]) {
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify(selector+" .artifact-inline-toggle")})?.scrollIntoView({block:"center"});true`);
    await sleep(150);
    await rp.click(panel,selector+" .artifact-inline-toggle");
    assert.equal(await rp.evaluate(panel, `document.querySelector(${JSON.stringify(selector+" .artifact-inline-toggle")})?.getAttribute("aria-expanded")`),"true","A/B 预览都应实际展开");
  }
  const probe = (id: "A" | "B", set?: string) => {
    const selector = (id === "A" ? a : b)+" .artifact-inline-frame";
    return rp!.evaluate(panel,`(async () => {
      const frame = document.querySelector(${JSON.stringify(selector)});
      const nonce = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const onMessage = event => {
          if (event.source !== frame?.contentWindow || event.data?.probeResult !== ${JSON.stringify(id)} || event.data?.nonce !== nonce) return;
          window.removeEventListener("message", onMessage);
          clearTimeout(timer);
          resolve(event.data);
        };
        const timer = setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error("iframe probe timeout")); }, 4000);
        window.addEventListener("message", onMessage);
        frame.contentWindow.postMessage({probe:${JSON.stringify(id)}, nonce, set:${JSON.stringify(set)}}, "*");
      });
    })()`) as Promise<{probeResult:string;text:string;instance:string;version:string}>;
  };
  await until(async()=>await probe("A","A 填写内容").catch(()=>undefined),12_000,"卡片 A 可交互");
  const firstA = await probe("A");
  await until(async()=>await probe("B","B 填写内容").catch(()=>undefined),12_000,"卡片 B 可交互");
  const firstB = await probe("B");
  await sendQuestion("只修改卡片 A");
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#messages")?.textContent.includes("本轮只改了 A，没有修改 B。")||undefined'),60_000,"第二轮模型回复");
  const order = await until(async()=>await rp!.evaluate(panel,`(()=>{
    const nodes = [...document.querySelector("#messages").children];
    const index = f => nodes.findIndex(f);
    const v = [index(n=>n.matches(${JSON.stringify(b)})),
      index(n=>n.matches(".msg.user")&&n.textContent.includes("只修改卡片 A")),
      index(n=>n.matches(".msg.assistant")&&n.textContent.includes("本轮只改了 A，没有修改 B。")),
      index(n=>n.matches(${JSON.stringify(a)}))];
    return v.every(n=>n>=0) ? v : null;
  })()`),15_000,"第二轮结束后的卡片排序") as number[];
  assert(order[0] < order[1] && order[1] < order[2] && order[2] < order[3],
    "未修改的 B 必须留在第一轮；只有 A 移到新回答后");
  const laterA = await probe("A");
  const laterB = await probe("B");
  assert.deepEqual({text:laterA.text,instance:laterA.instance},{text:firstA.text,instance:firstA.instance},
    "A 修改后自动排序不应销毁已展开的 iframe 和输入");
  assert.deepEqual({text:laterB.text,instance:laterB.instance},{text:firstB.text,instance:firstB.instance},
    "B 完全未修改，iframe 状态必须一直保持");
  assert.equal(await rp.evaluate(panel,`!!document.querySelector(${JSON.stringify(a+" .artifact-inline-stale")})`),true,
    "文件已更新时应提示保留旧输入，重新展开才会加载新版");
  await rp.screenshot(panel,join(out,"04-two-cards-next-turn.png"));
  // An explicit close/reopen is allowed to replace A's old live document.
  await rp.evaluate(panel,`document.querySelector(${JSON.stringify(a+" .artifact-inline-toggle")})?.scrollIntoView({block:"center"});true`);
  await sleep(150);
  await rp.click(panel,a+" .artifact-inline-toggle");
  await rp.click(panel,a+" .artifact-inline-toggle");
  const refreshedA = await until(async()=>await probe("A").catch(()=>undefined),10_000,"用户主动重开 A");
  assert.equal(refreshedA.version,"v2","用户主动刷新后显示刚修改的版本");
  assert.notEqual(refreshedA.instance,firstA.instance,"主动刷新可以重建 A；此前不得偷偷重建");
  const afterRefreshB = await probe("B");
  assert.equal(afterRefreshB.instance,firstB.instance,"刷新 A 不能影响 B");
  await writeFile(join(out,"artifact-result.json"),JSON.stringify({
    sandbox:metadata,permissionProbe:secrets,preservedEarlyPreview:kept,multipleCards:{order,firstA,laterA,firstB,laterB,refreshedA,afterRefreshB},
    passed:["真实 HTML 文件生成","助手回复未完即展开","流中组件状态与输入保持","真侧栏主动展开","沙箱隔离","二次确认草稿","关闭销毁沙箱","跨轮只重排修改的 A，B 保留旧轮位置","A/B iframe 状态均保留","文件更新后主动重开显示新版"]
  },null,2));
  console.log("PASS 真扩展 · 结果文件卡 / 交互沙箱 / 选择草稿 / 关闭");
} finally {
  if(rp){await rp.close();await rp.remove();}
  await new Promise<void>(resolve=>site.close(()=>resolve()));
  await model.close();
}
