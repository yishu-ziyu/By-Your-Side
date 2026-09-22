# 任务：从日常 Chrome 侧栏验证完整用户路径

2026-09-22。用户明确要求主代理直接通过 Computer Use 操作真实产品，随后要求先重载再试。本轮范围是构建、重载与真实路径验收；不修改产品源码、不提交、不推送。所有浏览器操作使用 `cua_repl` 的 Chrome 原生界面，未通过应用内部 API 派发测试请求。

## 完成标准

- [ ] J1 网页问答准确，来源可核对，页面未被修改。— 检查：主代理通过 Computer Use 读取原页面与真实侧栏。
- [x] J2 指定已打开标签页的切换实际到达正确页面。— 检查：Chrome 当前页面与侧栏。
- [ ] J3 公开原文跨页进入真实 Flomo 草稿，内容与来源正确，不保存或提交。— 检查：目标编辑器独立读回。
- [ ] J4 改口更新同一项工作，保留“不保存”等其他要求，不丢已有材料。— 检查：真实连续输入、目标编辑器与任务记录。
- [ ] J5 用户接管后停止旧动作；明确继续可从保留材料续接。— 检查：真实侧栏控制与页面结果。控制项通过，已有材料复用到最终成果未通过，完整标准保留未完成。
- [ ] J6 语音入口、答案/阻碍的交付及停声与停任务的区别。— 检查：仅记录本工具真实能覆盖的层级；麦克风输入与主观听感未覆盖时明确 NOT_RUN。

## 环境与重载

- 日常 ChromeMain，扩展 ID `fnbjglhppbkgmjeehablkfilmmefjolo`。在 Chrome 扩展详情页确认加载目录为本仓库 `extension/dist`。
- 重载前 Native PID 40676/40679，启动于 9/21 22:34。
- 用户要求重载后：`npm run typecheck` PASS；`npm run build` PASS。通过扩展详情页“重新加载”按钮重载。
- 9/22 14:07:01 新 Native PID 4150/4152；日志 14:07:10 显示启动及面板连接。旧 stdio 于 14:07:00 关闭退出。
- 配置读回：`model=minimax-cn/MiniMax-M3`、`displayFastPath=true`、`generalBrowserLoop=true`、`routeShadow=true`；`voiceSpokenResultGate` 未设置（源码缺省关闭）。启动日志报告 `opencode-go/deepseek-flash`，测试会话实际模型以侧栏与本次会话记录核对，不把全局配置等同于所有请求。
- 本次构建 SHA256：sidepanel.js `3044f765ea8276cd385eb65a503cc1a1aa2de580f10ffc1d7b7a33734fd9a5b8`；background.js `cebbbfbf2e496392c6ba01ed551bfaf3595d6ef08f60c3749a2d8e76553b66c3`；content-cursor.js `3808a2e90ce6b5caaa65d6eec14f91d1069432324459712977fbe7284c2d00bd`。

## 重载前观察（不计入重载后验收）

公开来源：`https://docs.typesafe.ai/concepts/system-one`。

输入：“这页里，Jev 目前支持哪些输入？只回答问题，不要修改网页或打开其他页面。”

侧栏回答与页面原文一致：仅文本，支持字符串、JSON 对象与文本数组，不支持图片/音频/视频；有来源链接，原网页未变。UI 显示执行耗时 **58s**，并把“捕获原文”“用 send_user_message 回答”展示为两个完成项。这是旧进程的真实观察，不代表重载后速度或质量。

Computer Use 初期坐标动作曾报 `noWindowsAvailable`、粘贴超时；改用最新完整 AX 控件索引与 `setValue` 后成功输入和发送。这些操控工具问题单独记录，不算产品故障。

## 重载后记录

本轮真实路径未通过。操作发生于日常 Chrome、真实扩展、真实模型与已登录 Flomo，未用测试夹具替代。侧栏中实际选用 MiniMax-M3；运行记录同样标记 `provider=minimax-cn, model=MiniMax-M3`。

| 用例 | 状态 | 真实结果 |
|---|---|---|
| J1 网页问答与交付 | FAIL | 后台已生成正确答案，侧栏多次读回仍显示“发送中，尚未确认接收”，没有可见回答；关闭再打开侧栏后为空白会话。后台 `latestDelivery=null`，不能把后台文本当作交付成功。 |
| J2 切换已打开的 Flomo | PASS，速度问题保留 | 实际切到原有 Flomo 标签页，URL 仍为 `mine?tag=292929%2C`，编辑器仍为空，侧栏正式交付。UI 耗时 **40s**，中途出现目标证据独立复核；不据这个单例推断总体延迟。 |
| J3 第一句原文 → Flomo 草稿 + URL | FAIL | 执行 **5m 20s** 后交付部分失败。捕获的材料包含 Note 全部三句，填写被原文一致性闸门拦下；真实编辑器仍为空。没有把空草稿记成成功。 |
| J4 “同一个 Note 的最后一句，其他不变” | FAIL | 修改被受理，但建立了新 run；原始要求只剩修改句。后续选中了另一个关于 System 1/System 2 的 Note，而不是原来关于输入类型的 Note；来源目标仍被记为 satisfied。填写再次被来源闸门阻止。 |
| J5 接管、交还、中止 | PARTIAL：控制行为 PASS，完整续接未完成 | 点击接管后 UI 显示“已暂停 · 页面归你”，后台为 paused，编辑器为空；点击页面“交还”后同一修改后的 run 恢复，保留两个剩余目标。相同填写失败再次出现后，点击中止；UI 与后台均确认停止。没有因此把保留材料到最终成果的完整标准勾为通过。 |
| J6 语音 | PARTIAL / NOT_RUN | 真实侧栏成功开启语音，供应商 ready；观察到一轮输入/回复及 playback_done 回执，随后关闭。该轮并非预设的受控口令，不能据此认证“别说了”、插话、声音自然度或真实可听效果。 |

### 输入与独立核对

J1 重载后输入与重载前相同。会话 `828c2809-c9ca-466f-ad30-bafcc42e8327`，run `692f6ace-857b-4a62-a042-89baf2de2751`：14:13:42 接收，14:13:57 后台生成正确回答；持久化状态为 idle、answer 目标 pending、`latestDelivery=null`。后续关闭/重开侧栏没有得到该回答。Computer Use 的 UI 连接也有局部失效，因此“侧栏未交付”与内部具体根因分开：本轮不宣称已经定位到某一个模块。

J2 输入：“切换到已经打开的 flomo 标签页。只切换标签页，不导航、不填写。”。实际当前页是原有 Flomo（tab 29965471），来源页仍为 System One（tab 29965468）。

J3 输入：“把已打开的《System One - TypeSafe AI》页面蓝色 Note 框的第一句英文原文，复制到当前 Flomo 的空白草稿，另起一行附来源网址。不要翻译或改写，不要保存或提交，不要更改 Flomo 筛选或打开其他笔记。”

- 期望正文第一行是 `Jev currently accepts text input only.`，第二行是来源 URL。
- 独立页面 AX 与截图确认原来源 Note 有三句，第一句是上述文字。
- 14:22:55 `capture_page_material` 实际返回 `note-first-sentence`，选择 `ax-3534` 整个片段，value 却包含三句；对应来源目标仍被标为 satisfied。
- 14:24:56、14:25:24 的填写回执均拒绝：“复制来源尚未核验，或填写内容与已保存原文不一致。”
- 同轮另有真实工具适配错误：调用未接入的 `page.type`；使用不支持的 `css:.tiptap.ProseMirror` 定位串。错误均保留，不把它们归咎于用户需求不清楚。
- 14:27:38 原运行 `735b1fa7-cbfc-479f-95b1-a505f777db4a` 结束，结果 unknown/partial，草稿为空。侧栏随后反问是否取第一句或允许整段，原要求已清楚，因此属于多余的用户救场负担。

J4 输入：“请继续原任务；把来源改成同一个蓝色 Note 提示框的最后一句英文原文，其他要求全部保持不变。”

- 期望仍是同一个输入类型 Note，最后一句为 `Images, audio, and video are not supported (yet).`，并保留 Flomo 目标、来源 URL 和不保存等约束。
- 14:31:22 创建新 run `9d08b3e6-273f-4fd6-b1d4-232034eed521`，`recoveryInput.requirements` 仅含修改句，未直接保留原始完整要求；是否仍可从其他历史恢复不在此项假定。
- 14:36:55 捕获结果的 purpose 明确为“第二个 Note 框 ax-3566”，value 是 System 1/System 2 的说明，和原 Note 无关；source-material-last 仍被记为 satisfied。这同时暴露来源对象与句子范围核验不足。
- 14:36:12 已再次出现相同填写闸门拒绝；继续捕获并未完成草稿。保留这次失败，未让主代理代替产品手工填入来冒充通过。

### 控制与收尾

- 14:32:26 接管后后台 paused；实际 UI 显示“已暂停 · 页面归你”“1 个 Agent 已暂停”，页面出现“交还”。暂停期间草稿保持为空。
- 点击“交还”后 UI 显示“原任务已恢复”“全队已恢复”，同一 `9d08…` 运行接续，其来源与填写目标保留。此处通过的是暂停/恢复控制，最终内容仍失败。
- 14:37:34 点击中止后后台 `state=aborted`；UI 确认“已停止”“已按你的要求停止，不会自动复活”。未继续重跑填写。
- 语音 14:39:04 ready，14:39:47 playback_done；14:40:17 closed，麦克风检查已经结束。无受控音频输入，不以事件或播放回执替代口令与听感验收。
- 本轮没有点击 Flomo 保存/提交，目标草稿在最终检查中仍为空。总笔记计数在页面初始异步加载期间有变化，不能单靠总数证明本轮保存与否；只依据本轮动作、目标编辑器与受控范围判断。

### 证据位置与版本边界

- UI 证据：本任务 Computer Use 的原生 Chrome AX 读回及截图，包括原页面、侧栏回答、实际切页、空草稿、暂停与停止状态。
- 本轮两个测试会话的去除模型思考内容后的运行证据：`out/acceptance/20260922-computer-use/runtime-evidence.json`；材料范围对照见同目录 `material-checks.json`。不包含用户其他笔记或语音转写。
- 本轮未修改产品源码。测试期间其他任务继续写入工作树，V2.3 后续改动不能自动算作已由 14:07 的进程加载；本轮只认该次重载与记录的构建。结束时三个扩展 bundle 的哈希与重载前一致。
- `voiceSpokenResultGate` 未设置，未更改用户配置；本轮语音连通检查不是 V2.3 开启后的静音质量验收。

## 后续修复顺序

1. 先修来源捕获与核验的范围：用户要求的句子、观察片段和填写值应有可核对的关系；来源 goal 不得在整段/错 Note 时 satisfied。保留写入闸门，不能以放松核验让错误内容通过。
2. 修复“继续原任务/其他不变”的目标继承与来源绑定，让原始约束和已捕获材料能被直接引用。
3. 修复普通回答的正式交付及 UI 状态；再拆分简单问答/切页的额外规划与核验成本。

这是实测后的建议，未在本轮实施产品修复；已有失败不因工程构建通过或控制项通过而被覆盖。

## 数据边界

使用新开的公开资料页与空白草稿；保留用户原会话及原笔记。只允许填写本轮草稿，不点击保存/提交。Flomo 首页存在与本任务无关的私人笔记，测试前先通过真实 UI 缩小可见笔记范围，避免把无关内容送入产品模型。验收记录不收录私人笔记、凭据或完整浏览记录。

## 修复后复测（2026-09-22 18:01–18:10，Kimi Code 会话续作）

复测环境与 14:07 轮同类：日常 Chrome、真实扩展、已登录 Flomo、侧栏实际选用 MiniMax-M3。消息进入面板当时打开的复制任务会话（运行记录落 `~/.sideagent/conversations/d505b83c-…`），先原句重发 J3、再原句发 J4 改口；不再依赖已被 dispose 的中断任务。最终加载版 background.js `7d12fa8b…`（构建于 18:10；与 17:43 版的差异仅为一条注释）。

### 基础设施扩充（用户批准，属验收工具链，不改产品逻辑）

- Cua Driver 0.7.1（`/Applications/CuaDriver.app`，身份 com.trycua.driver）daemon 已授权（Accessibility + Screen Recording）并可后台常驻。`hotkey` 的 background 模式经 macOS 14+ auth-message envelope 向指定 pid 投递可信按键：Chromium 接受为真实输入，不前台、不动真实鼠标；`click` 的 element_index+window_id 走 AX 路径，后台/隐藏窗口可用。
- 扩展 manifest 增加 `_execute_action` 命令（Command+Shift+Y / Ctrl+Shift+Y），background 增加 `setPanelBehavior({openPanelOnActionClick:true})`。效果：侧栏可随时用后台可信按键打开（实测 3 次均成功）；顺带修复「点工具栏图标无任何行为」。
- 实测边界：CDP 合成按键**不**触发浏览器级快捷键（Cmd+T 合成无效）——系统级可信按键是打开侧栏链路的唯一可行面；页面内真实输入仍走 CDP（insertText/鼠标事件）。typecheck、architecture（228 文件）、build 通过后重载验证。

### J3 复测：PASS（耗时 2m0s）

- 18:01:51 原句经真实键入+真实点击发送。run `6a0d2246`：列 tab 找到重开的 System One（tab 29965552）→ 读页面结构 → `capture_page_material` 取第一句（范围正确）→ 切到 flomo tab 29965553 → `type_text` 先被来源闸门拒（预期路径）→ `fill` 一次成功。
- 目标证据复核链起作用：首判 `matched:false`（0.63）并指出「setNodeHTML 整段覆盖、原文与 URL 拼接为单段、未形成两行结构」；模型改为两段结构后二判 `matched:true`（0.62），18:03:54 正式交付。
- 独立读回 Flomo 草稿：`<p>Jev currently accepts text input only.</p><p>https://docs.typesafe.ai/concepts/system-one</p>`，与来源 Note 第一句逐字一致，另起一行附来源 URL；未点击保存/提交。
- 14:22 轮的三个失败特征（整段误当第一句、5m20s 超时、闸门外绕行）均未复现。

### J4 复测：接续与捕获 PASS，改写被既有回执闸门阻断（部分完成）

- 改口继承实证： amendment 合并后 `task_goals` 回执中 requirement-1 原样保留、requirement-2（末句修订）并列在列，面板显示「+1 修订」——修复 2 在本路径生效。
- 来源重绑定实证：`capture_page_material` 捕获到**同一个**蓝色 Note 框的末句 `Images, audio, and video are not supported (yet).`——14:36 轮的错 Note/整段误绑未复现，修复 1 在本路径生效。
- 填写被拦：`fill` 返回「『填写 .tiptap.ProseMirror』已有成功回执（来自重启前），不能直接重放。若当前页面已不满足最新要求，请定位当前字段并用 `confirm_blocked_write` 核对/确认一次恢复。」随后 `confirm_blocked_write` 返回「结果项 auto-a-awqz 当前不是可恢复的表单状态，未执行确认」——确认路径对该字段不可用。
- 模型退路：Ctrl+A/Delete 清空草稿后重填，仍被同一回执闸门拒绝；三次相同错误后按设计停止，run 以「部分完成 · 还有 1 项未完成」结束。
- 副作用（如实记录）：模型为清空重填把 J3 已填入内容删除，复测后 Flomo 草稿为空。
- 结论：J4 的「改口保留其他要求 + 来源对象绑定 + 末句捕获」三项通过；「要求已修订后改写同一字段」仍被既有成功回执挡住，且 `confirm_blocked_write` 无可用恢复态。这不是放松写入核验能解决的——需要在修订成立且材料已重新捕获时，提供一条以新 revision 为键的回执失效/确认路径。

### J5 复测：接管请求未确认（未完成，附工具链瑕疵）

- J3/J4 运行中共 4 次点击「接管」（精确坐标与 JS click 两种方式）：面板均记录「接管请求还没得到确认，页面可能仍由 Agent 控制 / 再试」，未出现「已暂停 · 页面归你」；其中一次误点工具回执芯片（文本匹配命中「接管页面」chip），一次「再试」复点未落地（按钮查找命中隐藏元素）。第 4 次前 run 已自行结束（部分完成），「交还」未测。
- 不得据此判定产品故障（真人点击路径未复核），也不得记通过；需要一次真人路径的接管/交还复测。

### 中断任务续接入口：实测死路（产品发现）

- 该会话任务自 17:15:40（V2.3 重载断连）起 `state=interrupted / connection_lost`；17:38、17:43 两次扩展重载后 run 被 dispose（trace 有 abort/dispose），持久化快照仅剩 UI 残留。保留页面绑定为 chatgpt tab 29965355（任务上下文页，非 flomo/typesafe）。
- 表现：发文本只完成修订合并不起 run；点「继续原任务」无任何后端事件（无新 trace、无会话记录、无守卫文案）；激活保留页后点击同样无事件。对照 14:32 轮（tab 未丢时接管/交还有效），说明「保留 tab 丢失 + 伴随进程重启」后检查点续接入口不可用。

### 复测边界

- 只证明：J3 全过；J4 的继承/来源/捕获过，改写确认路径不过；J5 控制请求未确认；中断续接死路。不外推模型质量、语音与发布门槛。Flomo 未点保存/提交；模型请求均为日常 MiniMax-M3，未做模型对比实验。
