# 任务：禁用浏览器能力后，通用 JS 不能绕过禁用状态

2026-09-09，主代理在实现派工前冻结；补充原 S1 H3/H5/H6，不放宽原标准。

## 完成标准
- [x] 1. 当前注册表禁用任一既有 WRITE_TOOLS 能力时，direct js 与 browser_run/browser.js 均在 RPC 之前拒绝，错误指出不可用能力并给出 snapshot/read_element 观察替代；不依赖代码字符串或提示词。禁用 direct mark/browser.mark 仍拒绝。— 谁检查：主代理 `npx vitest run agent/test/harness-tool-access-evaluator.test.ts`
- [x] 2. 每次调用读取当前权限，工具创建后禁用、恢复均生效。全写能力启用或未提供权限回调时，两种 JS 入口正常转发；只禁用读工具不封 JS；受限时 snapshot/read_element 仍可调用。— 谁检查：同上
- [x] 3. 真实 disabled 语音入口运行结束后，没有任意覆盖层或目标样式/页面内容修改，没有 JS 到达执行器；正式答复说明未完成/当前不可用，不声称圈好。DOM oracle 必须先用手写覆盖层、样式修改、写入后删除证明能检测，不能仅查正式 mark shadow DOM。— 谁检查：主代理 `npx tsx scripts/acceptance/harness-capability-run.mts --case=disabled`，审阅 task-events 与页面证据
- [x] 4. 正常权限下 direct js/browser.js 通过生产浏览器 handler 实际读写受控页面并回读；正常圈画仍通过原手绘、动效、目标锚定、滚动、清除检查。— 谁检查：主代理真实浏览器 js_enabled 与 heldout 场景
- [x] 5. npm run typecheck、npm test、npm run build、git diff --check 通过，最终 diff 保留全部既有改动。— 谁检查：主代理
- [ ] 6. S1 完成机器检查后，由用户检查真实扩展的语音/文字圈画与纠正体验。— 谁检查：人

## 边界与不做
- 通用任意 page JS 无法可靠按意图拆权限，因此在写权限不完整时整体拒绝 JS（包括通过 JS 实现的 waitFor）；不做字符串黑名单。
- 复用 shared/control.ts 的既有 WRITE_TOOLS 集合，不另造标注关键词路由；全能力浏览器不受影响。
- worker 只改 agent/src/tools.ts；独立标准、测试、浏览器 oracle 与结果记录归主代理。
- 不重载用户扩展、不提交推送、不进入 S2 或 TTS。隔离浏览器证据不代称真人验收。

## 主代理验收结果

- 独立红测29失败/5通过；第二版独立终检34/34通过，全量115文件938项通过，typecheck/build/diff通过。
- 第一版拒收：真实JS因内部worker_tabs名字被误封；program总入口检查误封纯读取。主代理限定扩大worker到conversation-runtime.ts修take_tab映射，冻结结果要求未改。
- 最终disabled 9项、真实SDK JS读写/禁用/恢复11项、保留措辞圈画11项通过，源码hash均为 `3cb780d95364cbc6d8b9cd6cae2dd5c88451cafc156823b37f6c713d05355ace`。
- disabled模型实际尝试一次js，在RPC前收到mark未启用错误；DOM写入0，样式/HTML快照一致，正式答复明确无法画圈。其重载/截图替代建议未经验证。
- 正常圈画截图已由主代理检查。失败样本与结果见[结果台账](20260909-harness-s1-results.json)，保留旧disabled假阳性和本轮3个失败。
- 验收为隔离Chrome与合成麦克风路径；未重载用户扩展，第6项等待用户真人检查。
