// 网站方法（22 组）场景的脚本模型步骤：主验收与批准规则重放共用同一份声明。
import type { NestedCard, NestedGroup } from "./approval-plan.mts";
import type { Rule } from "./scripted-model.mts";

export const S22_RULE = "以后在这个网站填写并提交表单时，我都会先填写「备注」栏。";

export const S22_NOTE = "已电话确认，周五回访";

export const S22_PERSON = "姓名张三，电话 13800000000";

export const S22_FILL = [
  { tool: { name: "fill", args: { target: "input[name=name]", value: "张三" } } },
  { tool: { name: "fill", args: { target: "input[name=phone]", value: "13800000000" } } },
];

export const S22_CLICK = { tool: { name: "click", args: { target: "button", label: "提交" } } };

/** 每轮只尝试一次提交，收到拒绝后仍结束主回答；不靠模型自觉遵守记忆。 */
export const S22_RULES: Rule[] = [
  { match: "[S22-MISSING]", steps: [...S22_FILL, S22_CLICK, { text: "请提供备注内容。S22-MISSING-DONE" }] },
  { match: "[S22-INVENTED]", steps: [
    { tool: { name: "fill", args: { target: "input[name=note]", value: "无备注" } } },
    S22_CLICK, { text: "请提供实际备注。S22-INVENTED-DONE" }] },
  { match: "[S22-EXACT]", steps: [
    { tool: { name: "fill", args: { target: "input[name=note]", value: S22_NOTE } } },
    S22_CLICK, { text: "表单操作已结束。S22-EXACT-DONE" }] },
  { match: "[S22-BROWSER]", steps: [
    { tool: { name: "browser_run", args: { label: "填写并提交表单", code: `await browser.fill({target:"input[name=name]",value:"张三"}); await browser.fill({target:"input[name=phone]",value:"13800000000"}); return await browser.click({target:"button",label:"提交"});` } } },
    { text: "请补充备注。S22-BROWSER-DONE" },
  ] },
  { match: "[S22-ENTER]", steps: [...S22_FILL,
    { tool: { name: "press_key", args: { key: "Enter" } } },
    { text: "请补充备注。S22-ENTER-DONE" }] },
  { match: "[S22-OTHER-SITE]", steps: [...S22_FILL, S22_CLICK, { text: "其他网站操作结束。S22-OTHER-SITE-DONE" }] },
  { match: "[S22-DELETED]", steps: [...S22_FILL, S22_CLICK, { text: "删除方法后操作结束。S22-DELETED-DONE" }] },
  { match: "[S22-OVERRIDE]", steps: [...S22_FILL, S22_CLICK, { text: "这次按你的要求留空。S22-OVERRIDE-DONE" }] },
  { match: "[S22-EDGE-MISSING]", steps: [...S22_FILL, S22_CLICK, { text: "备注字段核对结束。S22-EDGE-MISSING-DONE" }] },
  { match: "[S22-EDGE-DUPLICATE]", steps: [...S22_FILL, S22_CLICK, { text: "备注字段核对结束。S22-EDGE-DUPLICATE-DONE" }] },
  { match: "[S22-EDGE-JS]", steps: [
    { tool: { name: "js", args: { code: `document.querySelector("form").requestSubmit(); "requested";` } } },
    { text: "页面脚本提交核对结束。S22-EDGE-JS-DONE" },
  ] },
  { match: "[S22-EDGE-POST]", steps: [
    { tool: { name: "js", args: { code: `fetch("/submit", {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"name=%E5%BC%A0%E4%B8%89&phone=13800000000&note="}).then(r=>r.text());` } } },
    { text: "POST提交核对结束。S22-EDGE-POST-DONE" },
  ] },
  { match: "[S22-LOWERPOST]", steps: [
    { tool: { name: "browser_run", args: { label: "小写post提交核对", code: `return await browser.fetch({url:"http://form.test/submit",method:"post",headers:{"content-type":"application/x-www-form-urlencoded"},body:"name=%E5%BC%A0%E4%B8%89&phone=13800000000&note="});` } } },
    { text: "小写POST提交核对结束。S22-LOWERPOST-DONE" },
  ] },
  { match: "[S22-SAVE-PROFILE]", steps: [{ text: "好的，已了解你的常用备注。S22-SAVE-PROFILE-DONE" }] },
  { match: "[S22-MEMORY]", steps: [...S22_FILL,
    { tool: { name: "fill", args: { target: "input[name=note]", value: S22_NOTE } } },
    S22_CLICK, { text: "使用个人资料的表单操作结束。S22-MEMORY-DONE" }] },
  { match: "[S22-FORGOTTEN]", steps: [...S22_FILL,
    { tool: { name: "fill", args: { target: "input[name=note]", value: S22_NOTE } } },
    S22_CLICK, { text: "需要重新提供备注。S22-FORGOTTEN-DONE" }] },
];

/** 22replace 的三个任务；take_tab 的 tabId 由场景在运行时填入练习站标签页。 */
export const S22_REPLACE_RULES: Rule[] = [
  { match: "[S22-REPLACE-PHONE-MISSING]", steps: [{ tool: { name: "take_tab", args: { tabId: 0 } } }, S22_FILL[0]!, S22_CLICK, { text: "请提供电话内容。S22-REPLACE-PHONE-MISSING-DONE" }] },
  { match: "[S22-REPLACE-UNDO-MISSING]", steps: [{ tool: { name: "take_tab", args: { tabId: 0 } } }, ...S22_FILL, S22_CLICK, { text: "请提供备注内容。S22-REPLACE-UNDO-MISSING-DONE" }] },
  { match: "[S22-PHONE-EXACT]", steps: [S22_FILL[1]!, S22_CLICK, { text: "电话表单操作结束。S22-PHONE-EXACT-DONE" }] },
];

/** 批处理步骤内部动作各自弹卡；值与对应 browser_run 代码里的调用逐字一致，改代码时同步改这里。 */
const S22_NESTED = new Map<string, NestedCard[]>([
  ["[S22-BROWSER]", [
    { tool: "fill", args: { target: "input[name=name]", value: "张三" } },
    { tool: "fill", args: { target: "input[name=phone]", value: "13800000000" } },
    { tool: "click", args: { target: "button", label: "提交" } },
  ]],
  ["[S22-LOWERPOST]", [{ fetch: { method: "POST", url: "http://form.test/submit", body: "name=%E5%BC%A0%E4%B8%89&phone=13800000000&note=" } }]],
]);

export function nestedFor(rule: Rule | undefined): NestedGroup[] {
  const cards = rule ? S22_NESTED.get(rule.match) : undefined;
  const parent = rule?.steps.find(s => "tool" in s && s.tool.name === "browser_run");

  return cards && parent && "tool" in parent ? [{ parent: parent.tool, cards }] : [];
}
