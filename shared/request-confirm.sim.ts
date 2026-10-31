/**
 * 确认门禁、确认卡句子、超时中文、过程行用词：假数据、不调浏览器。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRequest, needsRequestConfirm } from "./request-confirm.js";
import { confirmCopy } from "./send-confirm-copy.js";
import { describeTimeout } from "./timeouts.js";
import { liveStatus, runMetaLine } from "./run-status.js";

test("搜索类 POST 放行，写入和拿不准的要确认", () => {
  const ieee = {
    method: "POST",
    url: "https://ieeexplore.ieee.org/rest/search",
    body: JSON.stringify({ queryText: '"A Comprehensive Study on Cross-View Gait"', highlight: true }),
  };
  const send = { method: "POST", url: "https://mail.example/api/messages", body: JSON.stringify({ text: "hi" }) };
  const gqlQuery = { method: "POST", url: "https://app.example/graphql", body: JSON.stringify({ query: "query { viewer { id } }" }) };
  const gqlMut = { method: "POST", url: "https://app.example/graphql", body: JSON.stringify({ query: "mutation { send(id:1) }" }) };
  const unknown = { method: "POST", url: "https://shop.example/api/v2/cart", body: "{}" };
  const issue = { method: "POST", url: "https://api.github.com/repos/a/b/issues", body: JSON.stringify({ title: "New issue", body: "body" }) };
  const queryOutsideGraphql = { method: "POST", url: "https://api.github.com/repos/a/b/issues", body: JSON.stringify({ title: "New issue", body: "query" }) };
  const get = { method: "GET", url: "https://ieeexplore.ieee.org/rest/search?q=gait" };

  assert.equal(classifyRequest(ieee).intent, "search");
  assert.equal(classifyRequest(ieee).confirm, false);
  assert.equal(classifyRequest(ieee).query, '"A Comprehensive Study on Cross-View Gait"');
  assert.equal(classifyRequest(gqlQuery).confirm, false);
  assert.equal(classifyRequest(send).intent, "write");
  assert.equal(classifyRequest(send).confirm, true);
  assert.equal(classifyRequest(gqlMut).intent, "write");
  assert.equal(classifyRequest(unknown).intent, "unknown");
  assert.equal(classifyRequest(unknown).confirm, true);
  assert.equal(classifyRequest(issue).intent, "unknown");
  assert.equal(classifyRequest(issue).confirm, true);
  assert.equal(classifyRequest(queryOutsideGraphql).intent, "unknown");
  assert.equal(classifyRequest(queryOutsideGraphql).confirm, true);
  assert.equal(classifyRequest(get).confirm, false);
  assert.equal(needsRequestConfirm(ieee), false);
  assert.equal(needsRequestConfirm(send), true);
});

test("确认卡标题是人话，JSON 只进技术细节", () => {
  const body = JSON.stringify({ queryText: '"A Comprehensive Study on Cross-View Gait"', highlight: true });
  const searchCard = confirmCopy({
    host: "ieeexplore.ieee.org",
    label: "POST /rest/search",
    content: body,
    route: "request",
    method: "POST",
    path: "/rest/search",
    body,
  });
  assert.equal(searchCard.kind, "search");
  assert.match(searchCard.headline, /IEEE Xplore/);
  assert.match(searchCard.headline, /搜索/);
  assert.doesNotMatch(searchCard.headline, /POST|\/rest\/|\{/);
  assert.equal(searchCard.yes, "允许搜索");
  assert.ok(searchCard.quote?.includes("Comprehensive Study"));
  assert.equal(searchCard.tech?.path, "/rest/search");

  const sendCard = confirmCopy({ host: "mail.example", label: "发送", content: "周五下午三点开会。", route: "click" });
  assert.equal(sendCard.kind, "send");
  assert.equal(sendCard.yes, "发送");
  assert.equal(sendCard.no, "先不发");
  assert.match(sendCard.headline, /「发送」/);
  assert.equal(sendCard.quote, "周五下午三点开会。");
});

test("超时原文收成带耗时的中文", () => {
  const first = describeTimeout("first response timeout: openai/gpt sent nothing within 15 s");
  assert.ok(first);
  assert.equal(first.kind, "model");
  assert.match(first.copy, /15 秒/);
  assert.doesNotMatch(`${first.title}${first.copy}`, /timeout|sent nothing/i);

  const tool = describeTimeout('Tool call "click" timed out after 30000ms');
  assert.ok(tool);
  assert.equal(tool.kind, "tool");
  assert.match(tool.copy, /30 秒/);

  const stall = describeTimeout("stream idle timeout: x sent nothing for 30 s mid-response");
  assert.ok(stall);
  assert.match(stall.copy, /30 秒/);
});

test("过程行一直写正在做的那一步，等久了也不换成笼统的说法", () => {
  assert.deepEqual(liveStatus({ step: "搜索论文标题", from: 0, now: 10_000 }), { title: "正在：搜索论文标题", time: "10 秒" });
  assert.deepEqual(liveStatus({ step: "搜索论文标题", from: 0, now: 75_000 }), { title: "正在：搜索论文标题", time: "1 分 15 秒" });
  assert.equal(runMetaLine(21, 7), "已试了 21 步，其中 7 次没做成，已换别的方法");
  assert.equal(runMetaLine(2, 0), null);
  assert.equal(runMetaLine(1, 1), null);
});
