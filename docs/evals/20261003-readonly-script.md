# 任务：同步只读脚本失败后仍能填写，普通写脚本未知仍受保护

[验收入口](../testing/acceptance.md) · [结果不确定边界](../unknown-results.md) · [技术前置](../research/20261003-readonly-js.md)

## 完成标准

- [ ] 1. 真实 offscreen Agent 调用专用 `read_script({code})`。真实侧栏逐次批准精确参数。同步读 title、text 分别返回夹具独立固定文字。CPU 无限循环由 V8 中断或能力不支持时明确失败。回执不等30秒 RPC 超时，之后真实批准的 `fill` 写入用户原话。— 谁检查：本脚本，模型请求原文、审批来源事件、回执、独立页面值。
- [ ] 2. DOM/POST getter、含 getter/toJSON 的返回对象及 Promise 均明确失败。不序列化对象，不 await Promise。页面文字原样、服务器0POST。随后仍能真实批准并填写。— 谁检查：本脚本，回执、页面值、服务器计数、截图。
- [ ] 3. 普通 `js` 先POST一次，再返回永不完成的 Promise。原30秒 RPC 超时后，未知写入保护阻止下一次 `fill`，且不新增POST。— 谁检查：本脚本，实际请求/回执、审批记录、服务器计数、空字段。
- [ ] 4. 缺少工具或安全能力不支持是功能红结果，不算通过。不得降级普通JS。— 谁检查：本脚本；技术前置由主代理另验。

## 边界与不做

- 脚本模型只替代 provider 输出。工具、授权、任务账本、浏览器执行仍由产品实现运行；不代表真实 provider 或人工体验验收。
- 独立临时 HTTP 夹具。`#text` 是内容，`#evidence` 是填写目标，`/commit` 由服务器计数。普通JS对照最后执行，不能因前两个场景需要继续而降低写入未知保护。
- 仅允许当前夹具的精确只读代码、既定普通JS对照、用户当前任务原话里的填写值，以及有界 fixture snapshot/read_element。未知、恢复或额外 JS 卡一律拒绝并判失败。空宿主字段规则或 provenance 不赋予通用批准权限。
- 不修改生产代码、共享 harness 或现有安全验收。能力探针必须由未来后台在 ISOLATED 私有 global 上验证，不能由验收注入替代。其证据归属技术前置与后续产品实现，不用最终0POST倒推参数受到支持。
- 后台目标：强制 `throwOnSideEffect:true`、1秒 CPU timeout、不 await Promise、先取原生 objectId 后拒绝对象、不做返回值序列化，只交付有界 JSON primitive。不支持即失败关闭。

## 运行与证据

```bash
npx tsx scripts/acceptance/real-path/readonly-script.mts --headless
```

`launchRealPath` 从当前源码构建独立扩展和临时 Chrome profile。不碰日常 Chrome 或 `extension/dist`。主代理独占运行构建及浏览器，子代理只交付红验收入口。

产物位于 `out/issue-22/real-path/<时间>/`：`result.json` 保留真实模型请求及工具回执、每个审批ID/完整参数/决定、被动原生来源事件、每场景实际页面值、独立POST计数、失败原因及最终侧栏文字。每场景保存页面和侧栏截图；中断时保存失败截图与已有证据。

## 当前证据

仅脚本编写与静态阅读完成。没有运行构建、类型检查、测试或浏览器。完成标准尚未验收；主代理运行后将实测结果写回本节。生产实现仍未提供，不把“红验收入口就绪”写成已测红或已修复。
