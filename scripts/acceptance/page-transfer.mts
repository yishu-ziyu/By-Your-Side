import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {launchIsolatedExtension, until} from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless");

const out = resolve("out/acceptance", `page-transfer-${new Date().toISOString().replace(/[:.]/g, "-")}`);

await mkdir(out, {recursive: true});

const iso = await launchIsolatedExtension();

const evidence: Record<string, unknown> = {scope: "real built extension and isolated headless Chrome; controlled claim interleaving; no external model"};

let seq = 0;

const call = (cid: string, name: string, params: Record<string, unknown>) => iso.swEval(`globalThis.__saCall(${JSON.stringify(`transfer-${++seq}`)},${JSON.stringify(name)},${JSON.stringify(params)},"main",undefined,${JSON.stringify(cid)})`) as Promise<any>;

try {
  const first = await iso.newTarget(`${iso.fixtureOrigin}/transfer-first`);
  const second = await iso.newTarget(`${iso.fixtureOrigin}/transfer-second`);

  for (const target of [first, second]) {
    await until(async () => await iso.evalIn(target, "document.readyState === 'complete'") ? true : undefined, 10000, "fixture loaded");
    await iso.evalIn(target, "document.body.innerHTML='<label>备注<input id=note value=original></label>'");
  }

  const tabs = await iso.swEval("chrome.tabs.query({})") as Array<{id: number; url: string}>;
  const a = tabs.find(tab => tab.url.endsWith("/transfer-first"))!.id;
  const b = tabs.find(tab => tab.url.endsWith("/transfer-second"))!.id;

  for (const tabId of [a, b, a]) assert.equal((await call("A", "switch_tab", {tabId})).ok, true);
  // A's working pointer is on the transferring page; its other page must still work.
  await iso.swEval(`globalThis.__saPauseClaim=true; globalThis.__auditClaimResult=null;
    globalThis.__saCall("claim-a-b","worker_tabs",{action:"claim",tabId:${a},expectedConversationId:"A"},"main",undefined,"B").then(result=>{globalThis.__auditClaimResult=result;}); true`);
  await until(async () => await iso.swEval("globalThis.__saClaimPaused === true") ? true : undefined, 10000, "claim fence");
  const late = await call("A", "close_tab", {tabId: a});
  assert.equal(late.ok, false);
  assert.equal(late.executionFact, "not_executed");
  const competing = await call("C", "worker_tabs", {action: "claim", tabId: a, expectedConversationId: "A"});
  assert.equal(competing.ok, false);
  assert.equal(competing.executionFact, "not_executed");
  assert.equal((await call("A", "switch_tab", {tabId: b})).ok, true);
  assert.equal((await call("A", "fill", {target: "#note", value: "other-page-continues"})).ok, true);
  assert.equal(await iso.evalIn(second, "document.querySelector('#note').value"), "other-page-continues");
  await iso.swEval("globalThis.__saPauseClaim=false; globalThis.__saResumeClaim(); true");
  const claimed = await until(async () => await iso.swEval("globalThis.__auditClaimResult") as any, 10000, "claim completed");
  assert.equal(claimed.ok, true);
  const owner = await call("B", "worker_tabs", {action: "inspect", tabId: a});
  assert.equal(owner.data.conversationId, "B");
  assert.equal((await call("A", "close_tab", {tabId: a})).ok, false);
  assert.equal((await call("B", "fill", {target: "#note", value: "new-owner"})).ok, true);
  assert.equal(await iso.evalIn(first, "document.querySelector('#note').value"), "new-owner");
  Object.assign(evidence, {passed: true, lateOldClose: late, concurrentClaim: competing, owner: owner.data, otherPageValue: "other-page-continues", newOwnerValue: "new-owner"});
} catch (error) {
  Object.assign(evidence, {passed: false, error: String(error)});
  throw error;
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify(evidence, null, 2));
  await iso.close();
  console.log(JSON.stringify({out, ...evidence}));
}
