# 任务: agent 说不清你指的是哪个元素时，请你在页面上点一下；点中的元素直接用于下一步

## 背景

参考 Sitegeist 的 `ask_user_which_element`（`/tmp/sitegeist-study/src/tools/ask-user-which-element.ts`）。我们有语音，「这个」「那里」这类指代比打字更常见。现有能力只有「用户选中文字后提问」，缺「agent 主动请用户指一下」。用户 2026-09-23 同意先做这一项。

## 完成标准

- [x] 1. 真实路径：在真侧栏说「我指一个按钮给你，把我指的那个圈出来，不要点它」→ agent 请用户点选 → 用例用真实鼠标事件点「取消」→ 页面上的新标注圈在「取消」上。— 谁检查: `scripts/acceptance/real-path/point-then-mark.mts`
- [x] 2. 点选那一下不传给页面：「取消」按钮的点击计数保持 0。— 谁检查: 同上（页面自己记点击）
- [x] 3. 纠正路径：点选时按 Esc，agent 如实回复用户取消了，不新增标注。— 谁检查: 同上
- [x] 4. `typecheck`、`check:architecture` 通过；vitest 无新失败。— 谁检查: npm 脚本

## 设计（人机协作约定五环）

- 开始：agent 调 `ask_user_to_point`，工作页切到前台，页面顶部出现提示条（agent 给的说明 +「Esc 取消」）。
- 过程：鼠标悬停处画高亮框，并显示元素名；点在按钮里的文字上时，取整个按钮（最近的可交互祖先）。
- 核对：返回元素名、标签、文字和可直接交给 `mark`/`click` 的 `loc=css:` 定位；agent 用它继续做事。
- 纠正：Esc 取消，agent 得到「用户取消」，不猜。
- 故障：90 秒没点，返回「超时」；页面换了或工具出错，照常报错。点选期间页面收不到那次点击。

## 边界与不做

- 语音通道暂不接（先在文字任务里跑通）。
- 不做「点选多个元素」、不做点选后可调整范围。
- 用户接管页面期间不能发起点选（走现有控制闸门）。

## 续接：实现前补充的失败边界（2026-09-23）

- 原会话在写完本文件后遇到供应商错误，未开始产品实现。原四条标准不降低。
- 点选只提供目标身份，不新增点击、保存等授权；取消/超时后不得猜目标或自动重新请求。
- 点选期间停止任务、接管或控制轮次改变必须撤掉点选层；页面刷新不能把结果绑定到新文档。
- 点选需占用页面控制，但不生成持久写入义务，不能因等用户超时锁死任务的未知写入恢复。
- 首版只选择主文档的普通 DOM 元素；iframe 和自定义 Shadow DOM 控件不冒充已支持。
- 验收脚本先于实现落盘；用页面自己记录的输入事件和浏览器穿透标注层的实际几何位置作独立判据。
- 首轮核心两例通过后加查：网页在点选期间抢回按钮焦点，Enter 也不得激活它；真侧栏点击停止后 10 秒内撤掉点选层，不产生新标注。先补验收路径，再补键盘阻断。

## 实现与验证（ChatGPT 续作）

原会话 `36eeae1e-7534-4590-b480-902bee281cc8` 的第 676 条记录创建本文件，第 677 条确认写入，之后仅有供应商错误与用户继续请求。续作保留全部清理及其他会话的在途改动，没有重复执行仓库清理，也没有撤回共享源码。

实现入口为 `agent/src/tools.ts` → 既有 RPC/控制闸门 → `extension/src/background/exec/point.ts` → 隔离世界 `extension/src/content/point.ts`。结果契约与持久语义见 [协议](../protocol.md#用户指出元素)。点选使用独立遮罩和可信输入，工具输出沿用网页内容的非可信包装；没有把页面文字当成用户指令，也没有调整 Jev 阈值。Sitegeist 仅作交互参考，本轮未复制其实现源码。

### 真实路径

命令：`npx tsx scripts/acceptance/real-path/point-then-mark.mts --headless`。

环境为无窗口 Chrome for Testing、真实侧栏、真实 Native Messaging 伴随进程和真实 `cliproxy/mimo-v2.6-flash`。用例用 CDP 投递可信鼠标/键盘输入，不直接设置工具结果、不替模型画圈。结论不是人工听感或真人试用。

| 轮次 | 结果 | 证据 |
|---|---|---|
| 初始两例：选中后圈画、Esc 取消 | 13 项检查通过，exit 0 | [结果](../../out/acceptance/real-path/2026-09-23T07-24-58-408Z-point-then-mark/result.json) |
| 加查抢焦点后的 Enter、真侧栏停止；标注几何判据收紧为覆盖整个按钮 | 18 项检查通过，exit 0 | [结果](../../out/acceptance/real-path/2026-09-23T07-29-46-174Z-point-then-mark/result.json) |

两个按钮自己记录 pointerdown/mousedown/pointerup/mouseup/click；选择、取消、停止结束后事件数组均为空。标注由 Chrome `DOM.getDocument(pierce)` 和 `DOM.getBoxModel` 独立读取，检查位置与大小，不用生产定位逻辑计算期望。Esc 后无新标注；侧栏明确报告取消，原圈画要求保持未完成，没有虚报任务全部完成。停止按钮检查覆盖点选层在 10 秒预算内撤掉、无新标注及无网页输入。

同目录保留截图、侧栏文字、隔离会话记录与宿主日志。两轮的日常 dist 哈希均未变；隔离 Chrome 退出时宿主随之正常退出，未强杀日常进程。

### 工程检查

- `npm run typecheck`、`npm run check:architecture` 通过；架构检查覆盖 235 个产品文件。
- 最后一次 `npm run test:unit -- --reporter=json --outputFile=out/acceptance/user-point/vitest-final.json`：2,989 项，2,987 通过、2 失败；失败名称与 `out/cleanup/p6-vitest.json` 完全一致。[结果](../../out/acceptance/user-point/vitest-final.json)。未改这两条断言：`task-goals.test.ts` 的通用脚本审计完整性、`task-recovery-matrix.test.ts` 的被中断辅助脚本不确定性。
- 三个新增产品文件的定点 oxlint：0 规则告警、0 错误。末次真实路径之后仅补这两个新实现文件的可读空行，未再改变行为；最终 vitest 在补空行之后运行。
- 仓库整体 `git diff --check` 仍报告三个未触碰语音测试文件末尾多余空行（voice-audio、voice-auto-recovery、voice-recovery-evaluator）；没有为本票顺手修改它们。不能把本票通过写成整个仓库发布门禁全绿。

### 未跑与交付边界

90 秒自然超时、等待期间刷新/关闭页面、真实接管按钮、多会话争用与 iframe/Shadow DOM 负例没有实跑，相关保护不能按代码存在记成已验收。当前只交付主文档、文字任务的点选路径；语音接线、Windows/Linux、真人观感均未验收。

本轮未 commit、未 push、未重载日常扩展、未重启日常宿主、未改用户配置。原会话 14:15 的日常重建已完成，但它早于本轮点选功能；试用新功能仍需让扩展和伴随进程受控加载同一版本。

## 原会话最后的关联问题：三系统分发

第 688 条用户消息已明确目标是分发给他人，并支持 macOS、Linux、Windows，不需要再问 A/B/C 来猜目标。本票没有因此取得改造整个运行架构的授权。

当前 `scripts/install-host.mjs` 明确只适配 macOS，生成的 bash wrapper 仍依赖本机 Node、仓库绝对路径和 tsx。Chrome 的 [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) 本身覆盖三系统；不同系统的注册与启动方式须分别交付。Sitegeist 的 [依赖](https://github.com/badlogic/sitegeist/blob/main/package.json) 同样包含 Pi 系库，它的 [说明](https://github.com/badlogic/sitegeist#first-run) 还保留部分登录对 CORS proxy 的需求。因此「使用 Pi」「运行在浏览器还是本地进程」「用户安装是否方便」要分别判断。

建议后续先以「一台没有 Node/Pi CLI/开发者代理环境的干净电脑，能通过安装界面配置模型并完成第一次真实任务」定义分发验收。是否要求只装扩展、是否接受配套应用，属于安装体验约束；未确定该约束前，不自动迁移浏览器内 Agent，也不把改三份路径当三系统交付完成。
