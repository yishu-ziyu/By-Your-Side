# 浏览器组合执行

`browser_run` 是本地 Agent 工具。模型提供异步 JavaScript 函数体，程序通过 `browser` 调用现有浏览器工具。网页与标签页仍由扩展持有，程序不创建另一条浏览器连接。

## 用法

```js
await browser.hover({ target: "#project" });
await browser.waitFor({ selector: "#edit", timeoutMs: 5000 });
await browser.click({ target: "#edit" });
await browser.waitFor({ selector: "#draft" });
await browser.fill({ target: "#draft", value: "测试草稿" });
return (await browser.snapshot()).text;
```

这里的选择器只对应本地验收夹具。真实页面的目标必须先观察得到，不能直接套用。

- `browser` 的方法来自 `shared/protocol.ts` 的 `TOOL_NAMES`，排除内部 `worker_tabs`，另有 camelCase 别名与宿主组合 helper（`BROWSER_PROGRAM_HELPERS`，含 `waitFor` / `sleep` / `saveFile`）；以 `agent/src/browser-program.ts` 的 `programMethods` 为准，参数与独立工具一致，返回原始数据。已删除的工具（本机文件、上传、剪贴板、原始 CDP、拖拽与按住类输入、下载查询/取消/删除）连同别名不在程序里，也不写进工具描述；`api:"playwright"` 兼容层已删除（[删减验收](evals/20261004-cut-unused.md)）。例如 `snapshot()` 返回 `{text}`，`js({code})` 返回 `{value}`。
- `browser.waitFor({selector, timeoutMs})` 等待唯一、可见且未禁用的原生 CSS 目标。默认 5 秒，最多 30 秒；通过现有 `js` RPC 轮询，只读页面，不修改页面状态。
- `browser.sleep({ms})` 最多等待 10 秒，可中断。正常业务优先等状态，不用猜测睡眠时长。
- 方法参数是一个对象；不传或传 `null` 按 `{}`。传数字、字符串等位置参数时报 `browser.sleep takes one object of named fields…`；调用不存在的方法时报 `browser.x is not a browser method`，并列出可用的规范方法名（不含 camelCase 别名）。
- 每个操作都应 `await`。同一程序的浏览器操作顺序执行，未等待的剩余调用不会在程序结束后继续落地。
- `return` 返回可 JSON 序列化的证据。截图会作为图片附在工具结果中，程序只得到截图元数据。
- 程序变量仅在这一次调用内存在；标签页、Agent 原目标和现有会话按原机制保留。

## 存文件

页面或接口取到的大段数据（几千字以上）在程序里拼好，直接存成本会话文件，不要返回给模型再用 `artifacts` 重打：

```js
const { value } = await browser.js({ code: "(() => [...document.querySelectorAll('.line')].map(n => n.textContent))()" });
return await browser.saveFile({ filename: "subtitles.txt", content: value.join("\n") + "\n" });
```

- `browser.saveFile({filename, content})` 写进 `artifacts` 的同一个会话文件区：同样的文件名规则（一层文件名带扩展名）、同样 256 000 字上限，同名覆盖；侧栏出现同一张文件卡片。
- 返回 `{filename, chars, lines, overwritten}`；`content` 须是非空字符串。正文不进模型上下文，程序步骤（侧栏与诊断记录）只记文件名与字数。
- 只用页面 `js` 取数时不必进程序：`js({code, saveAs:"subtitles.txt"})` 把返回值（字符串原样，其他值存成 JSON 文本）按同一规则存成本会话文件，模型只拿到 `{filename, chars, lines}`；文件名先核对，不合规时脚本不运行。没有文件区的会话不列这个参数。
- 程序沙箱里没有 `window`、`document`、`Blob`、`fetch`、`setTimeout` 等页面全局；程序里写到它们时，报错直接说改用 `browser.js({code})`、`browser.saveFile`、`browser.sleep({ms})`，不是裸的 “is not defined”。自己写错的变量名照原样报。
- 只有带交付的主会话有文件区；没有文件区的会话里没有这个方法。程序在保存前被停止时不落盘。

## 控制与权限

解释器使用固定版本 `quickjs-emscripten@0.32.0`。独立 JavaScript 堆只暴露浏览器桥接函数，没有 Node `process`、`require`、宿主文件、宿主网络或模块加载器。页面 `js` 直接执行（10-04 起不再逐次确认，见[说明](browser-confirmation.md)）。解释器隔离不等于网页业务安全。

每次子调用携带所属 `programId`，经过原 `ToolRpc → 扩展 executeToolCall → ControlGate → handler`。程序调用在接管期间连只读工具也会被拒绝；普通独立只读工具的已有行为不变。

取消、接管错误、断连或 RPC 超时会永久停止当前程序的后续调用。脚本 `catch` 不能解除停止状态。新程序只有在现有控制机制允许时才能继续。

已经派发的动作按原机制排空，不宣称撤回。程序不会代替用户点击确认。页面脚本仍受既有用户授权与确认要求约束。

有页面操作结果未知时，闸门按每个子调用判定，不整段拒绝程序：读页、换页、不带 body 的 GET `fetch`、处理原生弹窗和 `saveFile` 照常，走到可能重复造成后果的那一步（点击、填写、页面脚本、POST 等）才停（规则见[协议](unknown-results.md)）。`waitForLoad`、`pageInfo` 读文档状态用的是宿主写死的只读探测（`HOST_PAGE_PROBES`，按代码全文匹配），不算重做页面脚本；`waitFor` 本来就用只读的 `read_element`；`scrollToBottomUntil` 的 `condition` 是模型代码，照旧受阻（[验收](evals/20261001-data-to-file.md)）。

## 执行预算与观察

- 默认单程序总时限 60 秒，内部测试可调但不超过 120 秒；这是程序执行预算，不是任务级固定次数熔断。
- JavaScript 堆 16 MiB，栈 256 KiB，每次同步执行片段约 100ms CPU 时间边界。
- 最多 32 个待处理浏览器调用，源码上限 64000 字符；程序输出和单次数据传递均有限制。
- 程序内部每步有父调用标识、顺序、参数、开始/结束、实际结果或错误和耗时。现有侧栏步骤卡显示子步骤，本地 trace 记录 `program_step`。
- 等待作为一个子步骤记录，返回轮询次数和最后观察值；每次轮询仍经过正常 RPC。
- 诊断日志隐藏程序源码，避免源码中内嵌的填写值绕过原脱敏规则；子动作输入继续默认隐藏，图片只留摘要。
- `out/acceptance/` 的现场数据和截图保持本地，不默认进入 Git。

## 验收入口

本地定点检查：

```sh
npx vitest run agent/test/browser-program.test.ts agent/test/run-trace.test.ts
```

`program-run.mjs` 和 `program-control-run.mjs` 是直连 ChromeMain 的历史验收入口，当前脚本没有无头隔离保护。不能把它们当默认验证命令直接执行；需要对应环境授权，并按现行无头要求选择或调整运行器。

真实浏览器脚本只使用 `local.yishu.chrome-main`，同一时间只能有一个验收操作者。对照区分“工具可用时模型自主选择”和“明确要求组合执行”，两者不能混报。测试只填写本地草稿，不提交数据。

## 参考

- ego lite 的一段 Node 脚本组合 browser helpers、观察后验证：本机 `/Applications/ego lite.app/Contents/Resources/ego-browser/SKILL.md`。
- [ego lite 执行器](https://github.com/citrolabs/ego-lite/tree/main/package/ego-browser/src/driver)。本轮借鉴组合操作形式，未移植整个 Node 运行环境。
- [QuickJS 嵌入、异步桥接与资源限制](https://github.com/justjake/quickjs-emscripten)。本轮不使用 `node:vm` 作为权限隔离依据。
- 原另一条执行路径 Jev 有界循环（`browser_loop`）与实时判断已于 2026-10-01 随 Jev 退役，规则原文见[历史](history/20261001-browser-decision-loop-retired.md)。
