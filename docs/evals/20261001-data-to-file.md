# 任务: 「提取 X 并保存」时，工具拿到的数据原样成为侧栏文件，不经模型重打

依据：用户 2026-10-01 日常试用（B 站《火线》8–10 集解说页，「提取字幕并且保存」，MiMo v2.6 flash）。用户要求修，并摸清根因是局部还是架构。

## 根因（诊断记录 `/tmp/daily-trace.jsonl` 与源码）

只装扩展的运行形态里没有「工具结果 → 文件」的路：唯一出文件的 `artifacts`（`agent/src/artifacts-tool.ts`）只收模型写在参数里的 `content`；`browser_run`/`js`/`fetch` 的结果只能回到模型上下文（`browser_run` 20000 字、扩展里 `fetch` 16000 字上限）。830 条/43315 字的字幕只能分段读回再由模型重打：第 1 次 `artifacts create` 只有 34005 字/658 条，停在 29:12；第 494 条（22:21）起时长全是整秒，是模型补写。模型比对字数不符后继续补救约 11 分钟，最后上游 429。`browser_run` 里 `window/document/Blob` 未定义是设计如此（程序在宿主沙箱，网页代码要放进 `browser.js`），不是根因。

性质：架构缺口。数据面唯一通道是模型上下文；本机模式在时有 `fetch savePath`、`download_save_as` 两条落盘路，10-01 退役后扩展里没有替代；`download_save_as` 在扩展里调用即报错（`node:fs` 垫片）却仍列给模型。

## 完成标准

- [x] 1. `browser_run` 程序里可以把手上的数据直接存成本会话文件（与 `artifacts` 同一处存放、同一张侧栏卡片、同样的文件名与大小规则）；模型只收到回执（文件名、字数、行数），内容不回到上下文 — 谁检查: 定点检查（先列失败方式）
- [ ] 2. 练习站放一个 830 条字幕接口；用户说「提取字幕并保存」：侧栏出现文件卡片，文件 830 条，每条时间轴与文字和接口逐字一致；回答说清条数；不空转（文件出现后本轮结束）— 谁检查: 真实路径验收，DeepSeek v4.1-flash、GLM-5.3-flash、MiniMax-M3.1-Flash-Preview 各一遍
- [x] 3. 扩展里用不了的工具不再列给模型（至少 `download_save_as`；其余由扫描结果决定）；本机检查用的循环不受影响 — 谁检查: 定点检查 + 工具清单读数
- [x] 4. 工具说明告诉模型：大段数据在程序里直接存文件，不要自己重打；网页代码放进 `browser.js` — 谁检查: 审查
- [x] 7. 原地转圈由产品自己察觉（用户 10-01 追加：「这些问题就是你」——不能靠用户发现再按停止）：同一任务里连续多步没有新进展（反复读同样的数据、反复撞同一个错、反复重做同一件事），产品自己停下，用一句话说明卡在哪一步、已经拿到什么、还差什么。用 10-01 B 站这次的真实记录做反例：11:59 生成文件后约 11 分钟反复读同一份字幕，应在这段里早早停下；正常的长任务（整页翻译约 70 秒、多页逐项操作）不能被误停 — 谁检查: 定点检查（真实记录回放 + 正常长任务对照）
- [x] 8. 停下或结束时的「已做 / 还差」与实际一致：这次字幕已取到 830 条，收尾却写「还没做：提取字幕」，不允许 — 谁检查: 定点检查
- [x] 5. 类型、全部单元测试、侧栏回归 23/23；长期文档同步 — 谁检查: 命令
- [ ] 6. 用户在原 B 站视频上复测 — 谁检查: 人

## 边界与不做

- 不做二进制文件（pdf、xlsx）；不写用户磁盘任意路径；不改 `artifacts` 已有命令的行为。
- 不在这一块重做「完成判断」：空转的原因是文件确实不完整。

## 共用约定

- 程序里的动作：`await browser.saveFile({ filename, content })`，返回 `{ filename, chars, lines }`；文件名与大小规则同 `artifacts`（一层文件名带扩展名，上限 256000 字）；同名再存为覆盖并在回执里写明。侧栏卡片与 `artifacts` 创建的完全相同（同一 `artifact` 事件）。之后模型可用 `artifacts get/update` 操作同一文件。
- 回执进上下文的只有文件名、字数、行数，不含内容。

## 标准 7、8 实测（2026-10-01）

信号（`agent/src/no-progress-policy.ts`）：一次任务里每个工具结果按「内容片段」（去 JSON 转义，抹掉 UUID、ISO 时间、长十六进制、10 位以上数字，按换行与 JSON 标点切开）与本任务已见片段比。新片段 ≥2% 或有真实动作（写类工具与程序里的写类步骤；`js`/`cdp` 只按结果判断）、正式交付、文件新建/修改/删除（含程序里 `saveFile` 的回执）→ 清零；几乎全是旧片段的成功结果、已见过的错误 → +1；程序里等待过（sleep/waitFor/waitForLoad）后读到的同样内容 → +0.5；第一次出现的错误 → 不计。累计满 6 停下本轮，走连续失败保护同一条交付通道（`failure_limit`），一段话说卡在哪一步、已有哪些文件（名字、字数、行数）、最近一次目标核对说还差什么；没核对过时未核对的计划目标只写「还没确认完成」。

回放（`/tmp/bilibili-stall-trace.jsonl` 去标识后存为 `agent/test/fixtures/bilibili-stall-20261001.json`，只留片段编号）：

| 时间 | 调用 | 计数 |
|---|---|---|
| 11:53:59–11:54:57 | 换切法重读字幕 ×4（各 ≤0.51% 新片段）、两个新错误（不计）、目标清单重读 | 1→5 |
| 11:55:08 | 模型正式交代进展 | 清零 |
| 11:55:50 | 再撞 `'Blob' is not defined` | 1 |
| 11:59:44 | `artifacts create`（不完整文件） | 清零 |
| 12:01:00–12:03:55 | 目标清单 ×1、重读字幕 ×4 | 1→5 |
| **12:05:20** | 目标清单重读 → **停下** | 6 |

回放的程序代码已脱敏，看不到程序里的步骤名，所以这个停点假设这些程序里没有等待步骤；若有，等待过的重读记半步，会晚停。停在生成文件后 5 分 36 秒、429（12:11:23）前 6 分钟，省掉其后 5 次调用和撞上 429 的那次请求。门槛 6 是保住 11:55 前那段（最高 5，以模型自己交代进展结束）的最小值；门槛 5 会在 11:54:57 停下，门槛 7 推到 12:06:26。片段比例 2% 与重读的 0.51% 有 4 倍余量。

正常长任务对照（`agent/test/no-progress-policy.test.ts`，全部不停）：整页翻译 14 批；3 页 × 8 次回执相同的点击 + 8 次程序内点击；下载进度 20 次轮询（字节在变）+ 10 次等待后读到同样状态（累计 4.5，不停；无限等待的同样读数第 13 次停）；12 个共用 40 行导航的不同页面。会话级（`agent/test/no-progress-session.test.ts`，扩展里的循环 + 脚本模型）：生成文件后反复读同一份数据，第 7 次读后本轮结束，只交付一段话，诊断记录有 `no_progress_stop`；停下时列的文件取会话记的本任务文件（用户插话清零计数后仍列出，删掉的不列）。

已知边界：数值不变的快速轮询（中间不等待）6 次会停，等待过的 12 次会停；用 `js` 做逐项写入且每次返回完全相同的结果会停。

标准 8 根因：模型把「提取字幕」列成 `condition` 目标，`condition` 只能用 `task_goals verify` 读当前页面核对，接口取到的数据不在页面上，没有任何核对途径，目标一直 `pending`；用户按停止后，侧栏一行（`resume-entry.ts` `compactLine`）只按计划目标写「还没做」。11:55:10 的目标核对其实判了「还差：保存字幕为文件」，但续做一开始进度快照就清掉了 `goalCheck`。主会话裁定改法（甲 + 窄版丙），已实现：
- 摘要来源顺序「最近一次核对的还差 → 模型自己列的未完成 → 计划目标」，没核对过的计划目标写「还没确认完成」，核对判做完时不再算剩余（`extension/src/sidepanel/resume-entry.ts`）；宿主催的续做开始时保留 `continue` 结论，之后存了新文件就作废（`agent/src/task-progress.ts`）。
- 本任务存下的文件（artifacts、`browser.saveFile`）以名字、字数、行数、存的时间交给目标核对，不带内容；只存文件、没动页面的任务也核对（`agent/src/session.ts`、`agent/src/goal-check.ts`）。
- 检查：`extension/test/resume-entry.test.ts` G1–G5（G1 即 10-01 原样：存好文件后按停止，原先写「还没做：提取…」）；`agent/test/goal-check-files.test.ts` H1–H4（真实会话：程序存文件 → 核对看到文件判做完、输入不含内容；下一个任务不拿上一个任务的文件）。改前全部失败，改后通过。

## 测量修正（标准 2，2026-10-01）

- 原判据：侧栏每张文件卡片都必须完整无损（830 条、起止毫秒、文字逐字一致）。原记录保留：MiniMax-M3.1-Flash-Preview 那次（`out/acceptance/real-path/2026-10-01T12-56-25-954Z-data-to-file-custom_MiniMax-M3.1-Flash-Preview/summary.json`）`file` 判为失败，原因是 TXT 写成「[00:00:01] 正文」（只有开始时间、精确到秒），CSV 的时间被逗号拆开读错。
- 修正理由：同次的 SRT 830/830 完全一致；TXT、CSV 是正确内容的有损附带版本，用户没有拿到错误内容。原判据把「多给了一份简化文件」当成数据被篡改，和标准 2 要防的「模型重打出错」不是一回事。
- 现判据（`scripts/acceptance/real-path/data-to-file.mts` 的 `judgeFiles`）：至少一份完整无损；其余每份按接口顺序恰好 830 条、文字逐字一致，出现的时间按显示的精度向下取整后与接口一致（只有文字、只有开始时间、表格都可以）。编造、缺条、乱序、文字改动、时间不符仍然失败（已用改过的副本逐项确认：时间错一秒、缺一条、两条对调、改一个字、插一句编造、CSV 毫秒差 1、没有完整版本，都判失败）。
- 重判（不开浏览器，`--rejudge=<目录>`，写 `rejudge.json`，原 `summary.json` 不动）：MiniMax 那次 fail → **pass**（SRT 完整；TXT 830 条、CSV 830 条 + 1 行表头，均无错误）；脚本模式 `2026-10-01T12-49-42-531Z-data-to-file-scripted` pass → pass。

## 标准 1–2：页面脚本结果未知后取数存文件被整段拒（2026-10-01）

- 实测：GLM-5.3-flash（`out/acceptance/real-path/2026-10-01T12-56-25-958Z-data-to-file-zai-coding-cn_glm-5.3-flash/diagnostics.jsonl` 第 84、111 行）。程序里一步 `browser.js` 报 `SyntaxError: Illegal return statement`，扩展按「已进入执行」记成结果未知；之后只做 `browser.fetch`(GET) + `browser.saveFile` 的程序在 fetch 那一步被拒「当前写入已暂停」，文件没存。
- 根因：`shared/task-next-step.ts` `assertTaskStepExecution` 把要过控制闸门的 GET fetch 一律算「写」，于是被未知写入暂停挡住；闸门本来就按 `browser_run` 每个子调用判定，`saveFile`、`artifacts` 不经 RPC、不受影响。
- 改法：不带 body 的 GET fetch 不受未知写入暂停（接管、取消、重启检查点、同一未知动作的重放保护不变）；POST/带 body、点击、输入、页面 JS、导航照旧停下；拒绝文案告诉模型哪些仍可做。契约见 [协议](../protocol.md#fetch-读取与未知结果边界)。
- 检查：`agent/test/unknown-write-program-steps.test.ts`（生产装配，先复现原拒绝）：读页 + GET + saveFile 程序完成且未知结果仍在；同程序里 click 不发出；POST 不发出也不占确认；页面脚本不重做；artifacts 可用。改前 1、2 两条失败，改后 5/5 通过。真实模型复测未跑。
- 未处理：语法错误时脚本根本没运行，却记成结果未知（`extension/src/background/index.ts` 进 handler 前置 `unknown`，`exec/evaluate.ts` 不区分编译失败）；另排。
- 追加（同日，协调方采纳后）：编译不过的页面脚本现在报 `not_executed`——`extension/src/background/exec/evaluate.ts` 先 `Runtime.enable` + `Runtime.compileScript`（只编译不运行，已在无头 Chrome 实测：`return 1` 报 SyntaxError 且不执行；`JSON.parse` 运行时 SyntaxError 只在运行时出现），编译通过后运行中的报错仍按未知。`waitForLoad`/`pageInfo` 的宿主只读探测按代码全文匹配（`shared/effect-policy.ts` `HOST_PAGE_PROBES`），不再被「不能自动重做」挡住；`scrollToBottomUntil` 的 `condition` 照旧受阻。检查：`extension/test/evaluate-js.test.ts`（编译失败未运行且 not_executed；运行中报错不带 not_executed）、`agent/test/unknown-write-program-steps.test.ts` 7–9。改前 evaluate 用例 1、探测用例 8 失败，改后通过。真实模型复测仍未跑。

## 最终验收（2026-10-01 晚，全部修复之后）

| 检查 | 结果 | 证据 |
|---|---|---|
| 脚本模型 | 通过 | `out/acceptance/real-path/2026-10-01T13-15-07-007Z-data-to-file-scripted` |
| GLM-5.3-flash | 通过：830 条逐条一致，文件出现后不再空转（修前被未知结果闸门挡住） | `…13-15-07-003Z-data-to-file-zai-coding-cn_glm-5.3-flash` |
| MiniMax-M3.1-Flash-Preview | SRT 830 条逐条一致；附带的纯文本文件开头有几行标题信息，按测量修正重判见上节 | `…13-15-07-007Z-data-to-file-custom_MiniMax-M3.1-Flash-Preview` |
| DeepSeek v4.1-flash | 未完成，两次都一样：没找到页面内嵌数据指向的字幕接口，判断「这页没有字幕」并如实告知，没有编造；属模型探索，产品路径未被触发 | `…13-15-07-015Z-data-to-file-opencode-go_deepseek-v4.1-flash` |
| 侧栏回归 | 23/23 | `out/acceptance/sidebar-interaction/data-to-file` |
| 单元检查 | 2964 项通过 | 命令输出 |

标准 2 结论：产品路径在 GLM、MiniMax 上成立；DeepSeek 卡在「找不到数据源」这一步，另行观察。标准 6（用户在原 B 站视频上复测）待做。

另排：扩展里不再提供的能力——上传本机文件、请帮手并行、粘贴富文本——是否在扩展里真正做出来，由用户决定。
- 补充（同日）：附带文件开头最多 8 行对不上字幕的行算表头（标题、视频号、条数、来源），不论是否含数字；之后 830 条须连续、按顺序，表头之后再有对不上的行仍算失败。起因：`2026-10-01T13-15-07-007Z-…MiniMax…` 的纯文字版前 3 行说明里有「12.3万」，被当成时间而判失败；该次另存为 `.txt` 名的 SRT 照常认作完整版本。重判：该次 fail → **pass**，`12-56-25-954Z` MiniMax pass，脚本模式 pass；9 行表头、表头后缺一条、插入编造、结尾多一行都判失败。
