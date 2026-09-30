# 任务: 产品只剩扩展一种形态，扩展用不到的代码移出主线，扩展里每个现有功能不变

用户 2026-10-01 裁决：本机助手模式退役，Jev 随之退役，杂物清理；技能复用与 EverOS 另议。依据：代码盘点（扩展里无孤儿文件，冗余集中在只在本机模式可达的整块功能）与 [路线图](../ROADMAP.md) 第 6 条「产品形态只做扩展」。

## 完成标准

- [x] 1. 第 1 批：删除扩展里确认无人调用的代码，类型、全部单元测试通过 — 谁检查: `npm run typecheck`、`npm run test:unit`
- [x] 2. 第 1 批后隔离真侧栏 23/23 仍通过 — 谁检查: `sidebar-interaction.mts --headless`
- [x] 3. 第 2 批第一步：安装指南、使用说明、路线图、状态页不再把本机模式当作使用方式 — 谁检查: `npm run check:docs` + 人
- [x] 4. 第 2 批第二步：依赖本机程序的浏览器检查逐套切到只装扩展并跑通；跑真实模型前先报额度等用户同意 — 谁检查: 各脚本 `--headless` 结果（「没做完的一行」为产品缺口，检查保留失败）
- [x] 5. 切完后删除本机入口、扩展里连接本机程序的代码与 Jev；扩展构建、全部单元测试、真侧栏通过；架构、协议、语音文档同步 — 谁检查: 同 1、2

## 边界与不做

- 历史验收、证据与其引用的脚本、数据不删（与 10-01 文档清理的原则一致）。
- 技能复用保留在主线、以后接进扩展（[路线图](../ROADMAP.md)第 10 条），本任务不动；EverOS 移出主线，随第 2 批删除。
- 行为相近但细节不同的重复函数（页面操作里的节点调用与 ref 解析）不合并：合并会改变边界输入的行为，收益约 25 行。

## 第 1 批记录（2026-10-01）

删除约 290 行：侧栏永久隐藏的「中止」按钮及其接线（停止改由发送键原地变形承担，状态标志保留）、无调用方的工具图标表与对应图标导入、无引用的危险确认浮层样式；9 个只有定义没有调用的函数（内存文档、控制确认快照、子 frame 会话两项、网络捕获四项、页面事件账本）。

盘点里列为「从不运行」的测试经核对不成立：`scripts/acceptance/*.test.mts` 用 `node --import tsx --test` 运行（文件首行注明，已复跑通过）；`tools/oxlint/**` 是外部引入工具自带的规则测试。二者保留。

证据：类型检查通过；全部单元测试 286 文件 / 3118 项通过；隔离真侧栏 `out/acceptance/sidebar-interaction/cleanup-b1` 23/23。

## 第 2 批记录

2026-10-01 摸底：浏览器检查的共用驱动默认注册本机程序，约 8 套真实路径检查（日常 10 条、记忆、圈画、语音、没做完的一行等）依赖它，多会话协作检查只能靠它；直接删会让这些检查失效。用户选择分两步。原计划第一步「扩展不再连接本机程序」会立刻让这些检查失效，改为先只撤使用说明，扩展连接代码与检查切换完成后一起删。

第一步已做：安装指南改为只装扩展；使用说明删去 Jev 显示加速一节；路线图第 9 条记录裁决；状态页与架构注明退役中。

第二步（2026-10-01，用户批准额度并指定模型：DeepSeek v4.1-flash 走 OpenCode 套餐，GLM-5.3-flash 走智谱编程套餐，语音走阶跃；两条文字线与语音线并行，线内串行）。7 套检查切到只装扩展：本机数据目录、Pi 会话文件等证据改为设置页导出的诊断记录、扩展存储、offscreen 请求记录；「伴随进程随 Chrome 退出」改为「从未启动本机程序」；剪贴板自有服务在扩展里不存在，记 n/a 并说明。

| 检查 | 模型 | 结果 | 证据 |
|---|---|---|---|
| 日常 10 条 | DeepSeek | 10/10 | `out/acceptance/real-path/2026-09-30T18-01-53-133Z-everyday-baseline-inproc/` |
| 填表不保存 | DeepSeek | 全部通过（c4 n/a） | `…/2026-09-30T18-00-46-725Z-codename-no-save/` |
| 圈画 + 切换动效 | GLM | 5/5 | `…/2026-09-30T17-58-59-455Z-mark-motion-toggle/` |
| 点选后圈画 | GLM | 18/18 | `…/2026-09-30T18-00-07-559Z-point-then-mark/` |
| 没做完的一行 | GLM、DeepSeek | 均失败：侧栏「还差」一行为空 | `…/2026-09-30T18-01-33-260Z-unfinished-turn/`、`…/2026-09-30T18-07-40-577Z-unfinished-turn/` |
| 语音问页面 | 阶跃 + DeepSeek | 5/5 | `…/2026-09-30T17-58-38-999Z-voice-page-question/` |
| 语音迁移验收（复跑） | 阶跃 + DeepSeek | 8/8 | `…/2026-09-30T17-59-03-799Z-inproc-voice-question/` |

用量约 18 个文字任务、2 段语音。「没做完的一行」两个模型都失败，诊断记录里目标核对已知「还差找到并圈出升级套餐按钮」，但侧栏没收到可显示的未完成项；09-25 该功能只在本机模式验收过。原因未查，另立问题，不在本任务修。


## 第 2 批删除（2026-10-01）

第一阶段（本机入口）只做了不牵连其他检查的部分，约 4,800 行：

- 本机入口：伴随进程主程序与 stdio 传输、macOS 剪贴板服务（连同依赖它的富文本粘贴检查 `browser-capability-paste.mts`）、安装脚本；npm 脚本 `dev:agent`、`install:host` 删除，`doctor` 不再查本机宿主清单。
- 验收后门：验收模型、验收能力令牌、协议里的三条验收消息及校验、会话与 Fleet 里的验收续跑记录；多 Agent 协作与会话管理两套检查（`accept:team`、`accept:sessions`）及其驱动、结果判定与单元测试。
- 真实路径驱动不再注册本机伴随进程，`withoutNativeHost` 保留为无效参数；`inproc-voice.mts --native` 改为报错。

第一阶段时暂未删除、等待裁决（用户随后选第 3 种，见下）：Node 会话循环（`node-agent-loop.ts`、`cliproxy.ts`）与扩展的 Native Messaging / WebSocket 连接。`eval:live`、`accept:journeys`、P0 本地运行、v23 两套检查仍在 Node 里托管会话并经 WebSocket 回退接入隔离扩展，删掉会让它们失效。

证据：类型检查通过；单元测试 281 文件 / 3083 项通过（与本机代码一起删除的测试文件 5 个、protocol 用例 2 项）；隔离构建通过；`lint-changed` 无新增；隔离真侧栏 `out/acceptance/sidebar-interaction/retire-stage1` 23/23。

### 第一阶段补完（用户选第 3 种：Node 会话循环与 WebSocket 回退留作测试基础设施）

- 扩展不再尝试 Native Messaging：`uplink.ts` 启动即连扩展内 agent；offscreen 文档建不起来且存储里有 token 时才回退 WebSocket（只给测试用）。`manifest.json` 去掉 `nativeMessaging` 权限；同时到达的两次连接不再重复建 offscreen 文档。
- 摸底发现：用户旅程与 P0 本地运行自 09-24 扩展内 agent 上线后就连不到它们的 WebSocket 宿主（扩展先连上 offscreen），与这次删除无关。两套脚本改为先关掉 offscreen 文档并让它建不起来、再写 token；一次性探针（隔离构建、零模型）确认：改前 `reachedWs=false`，改后 `reachedWs=true`、收到带 token 的 `hello`。
- `node-agent-loop.ts` 与 WebSocket 回退各加注释：只给测试用，这些检查改到扩展里跑后删除（见 STATUS）。

### 第二阶段：Jev / TypeSafe（约 11,000 行，源码约 4,000、测试约 4,700、脚本约 3,000）

- 删除：Jev 客户端与传输、TypeSafe 凭据读取、网页决策循环（`browser_loop` 工具、窄问题、动作选择、直接交付、字段材料生成、决策预算）、语音 `judge_browser_action`、显示快路（新任务与运行中修改）、整句快捷判断 `decideFastTask`、影子路由与语音播报闸门；配置开关 `generalBrowserLoop`、`browserLoopDirectDelivery`、`displayFastPath`、`displaySteerFastPath`、`routeShadow`、`routeShadowDailyLimit`、`voiceSpokenResultGate`；扩展构建里对应的两个替换件。
- 只删 Jev 分支、其余保留：目标核验直接由当前任务模型复核（扩展里 Jev 本来就不可用，走的就是这条）；技能快捷路径只做精确/模板匹配，语义匹配需注入判断；学习资格没有默认判断，一律按「不可用」不生成可自动复用的候选；`fast-task.ts` 只剩技能候选类型；`shared/browser-decision.ts` 保留扩展仍在产出的观察类型与候选计算，删掉只给循环用的类型。
- 脚本：删除 `jev-compare/`、`route-shadow-spoken-result.mts`、`display-steering-oracle`、`general-browser-evaluation.mts`（及其单元测试）、依赖播报闸门的 `realtime-spoken-result-live`、`v23-joint-live`、`v23-switch-verification-live`；隔离能力验收去掉走 Jev 的 S4–S7。`browser-review-regressions.mts` 不依赖 Jev，保留。
- 测试：删去只测已删代码的测试文件；`display-steering`、`edit-receipts`、`browser-initial-path`、`realtime-spoken-result` 只留不依赖 Jev 的用例；`config` 改为核对旧开关被忽略；`tool-surface` 确认清单里不再有 `browser_loop`；`realtime-feedback-translation` A1 改为闸门退役后的行为（工具结果回传后照常续答一次）。
- 用户可见的唯一变化：语音工具列表不再有 `judge_browser_action`（扩展里它读完页面后总报「Jev 凭据不可用」）。

### 第三阶段：EverOS（约 360 行）

删除 `scripts/everos/`（桥接、管理、测试）与 `memory-everos-learning.py`、`memory-embedding-server.py`；说明页移到历史（`docs/history/20261001-everos-retired.md`）。仓库里没有 EverOS 的 npm 脚本或 agent 代码。本机已安装的服务（`~/.sideagent/everos/`）与 LaunchAgent `local.by-your-side.everos` 属于用户机器状态，未动；它读的经历目录只由已退役的本机程序写入，之后不会有新输入。

### 检查结果

| 检查 | 补完第一阶段 | 第二阶段 | 第三阶段 |
|---|---|---|---|
| `npm run typecheck` | 通过 | 通过 | 通过 |
| `npm run test:unit` | 281 文件 / 3083 项 | 261 / 2753 | 261 / 2753 |
| 隔离构建（`/tmp/bys-retire-dist`） | 通过 | 通过 | 通过 |
| `lint-changed` | 无新增 | 无新增 | 无新增 |
| 隔离真侧栏（脚本模型） | 23/23 `retire-stage1b` | 23/23 `retire-stage2` | 23/23 `retire-stage3` |

另跑：隔离能力验收 CI 子集（`--only=F1,F2,F3,F4,F4b,F5,C1,C2,S1,S2`，零模型）10/10，`out/acceptance/browser-capability-integration-v2-2026-09-30T19-10-26-937Z/`；`check:architecture` 通过；`runner-lifecycle.test.mts` 17/17。真实模型各一次（DeepSeek v4.1-flash，语音走阶跃）：语音问页面 5/5（`out/acceptance/real-path/2026-09-30T19-12-48-781Z-voice-page-question/`）；日常整套 14/15（`…/2026-09-30T19-12-47-704Z-everyday-baseline-inproc/`），唯一失败 `translate-long-stop` 的原因是「停止前已全部译完，没测到停止」——DeepSeek 在 30 秒停止点之前就译完了，测量条件没满足，不是回归。`check:docs` 只剩 `.ship/` 的 5 条既有错误。

