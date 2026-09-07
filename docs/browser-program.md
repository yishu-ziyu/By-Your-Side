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

- `browser` 包含 `shared/protocol.ts` 的全部 17 个浏览器方法，参数与独立工具一致，返回原始数据。例如 `snapshot()` 返回 `{text}`，`js({code})` 返回 `{value}`。
- `browser.waitFor({selector, timeoutMs})` 等待唯一、可见且未禁用的原生 CSS 目标。默认 5 秒，最多 30 秒；通过现有 `js` RPC 轮询，只读页面，不修改页面状态。
- `browser.sleep({ms})` 最多等待 10 秒，可中断。正常业务优先等状态，不用猜测睡眠时长。
- 每个操作都应 `await`。同一程序的浏览器操作顺序执行，未等待的剩余调用不会在程序结束后继续落地。
- `return` 返回可 JSON 序列化的证据。截图会作为图片附在工具结果中，程序只得到截图元数据。
- 程序变量仅在这一次调用内存在；标签页、Agent 原目标和现有会话按原机制保留。

## 控制与权限

解释器使用固定版本 `quickjs-emscripten@0.32.0`。独立 JavaScript 堆只暴露浏览器桥接函数，没有 Node `process`、`require`、宿主文件、宿主网络或模块加载器。浏览器页面本身的 `js` 能力保持原状，不能把它和宿主权限隔离混为一谈。

每次子调用携带所属 `programId`，经过原 `ToolRpc → 扩展 executeToolCall → ControlGate → handler`。程序调用在接管期间连只读工具也会被拒绝；普通独立只读工具的已有行为不变。

取消、接管错误、断连、RPC 超时或危险点击返回 `held` 会永久停止当前程序的后续调用。脚本 `catch` 不能解除停止状态。新程序只有在现有控制机制允许时才能继续。

已经派发的动作按原机制排空，不宣称撤回。程序不会代替用户点击确认。页面脚本仍受既有用户授权与确认要求约束。

## 执行预算与观察

- 默认单程序总时限 60 秒，内部测试可调但不超过 120 秒；这是程序执行预算，不是任务级固定次数熔断。
- JavaScript 堆 16 MiB，栈 256 KiB，每次同步执行片段约 100ms CPU 时间边界。
- 最多 32 个待处理浏览器调用，源码上限 64000 字符；程序输出和单次数据传递均有限制。
- 程序内部每步有父调用标识、顺序、参数、开始/结束、实际结果或错误和耗时。现有侧栏步骤卡显示子步骤，本地 trace 记录 `program_step`。
- 等待作为一个子步骤记录，返回轮询次数和最后观察值；每次轮询仍经过正常 RPC。
- 诊断日志隐藏程序源码，避免源码中内嵌的填写值绕过原脱敏规则；子动作输入继续默认隐藏，图片只留摘要。
- `out/acceptance/` 的现场数据和截图保持本地，不默认进入 Git。

## 验收入口

```sh
npm test -- agent/test/browser-program.test.ts agent/test/run-trace.test.ts
node --import tsx scripts/acceptance/program-run.mjs
node --import tsx scripts/acceptance/program-run.mjs --mode=program --explicit=yes
node scripts/acceptance/program-control-run.mjs
```

真实浏览器脚本只使用 `local.yishu.chrome-main`，同一时间只能有一个验收操作者。对照区分“工具可用时模型自主选择”和“明确要求组合执行”，两者不能混报。测试只填写本地草稿，不提交数据。

## 参考

- ego lite 的一段 Node 脚本组合 browser helpers、观察后验证：本机 `/Applications/ego lite.app/Contents/Resources/ego-browser/SKILL.md`。
- [ego lite 执行器](https://github.com/citrolabs/ego-lite/tree/main/package/ego-browser/src/driver)。本轮借鉴组合操作形式，未移植整个 Node 运行环境。
- [QuickJS 嵌入、异步桥接与资源限制](https://github.com/justjake/quickjs-emscripten)。本轮不使用 `node:vm` 作为权限隔离依据。
