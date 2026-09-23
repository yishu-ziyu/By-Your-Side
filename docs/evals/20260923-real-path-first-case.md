# 任务: 在隔离的无窗口 Chrome 里，用真侧栏、真伴随进程、真模型跑通「把代号填成星河，不要保存」，全程不碰日常数据

## 背景与裁决

- 依据：[端到端测试基础设施小实验](20260923-e2e-infra-probes.md)。隔离要两处产品改动：一个数据目录设置；剪贴板端口改成每个实例各用各的。
- 2026-09-23 用户裁决：先做这两处改动，再跑第一条样板用例；Jev（TypeSafe）也接真服务。
- 用户实际入口：日常 Chrome 的侧栏，通过 Native Messaging 拉起 `~/.sideagent/native-host.sh`，再由它启动 `agent/src/main.ts`。本任务不改变这条入口的行为。唯一可见的变化：伴随进程的剪贴板服务仍先用 7761，被占时改用随机端口，并在握手 `hello_ok` 里把端口告诉扩展；扩展只连握手里给的端口。
- 测试入口：`npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless`。

## 完成标准

- [x] 1. 设了 `SIDEAGENT_DATA_DIR` 的伴随进程，把自己写的东西都放进这个目录：本次运行标记（练习页地址里的随机串）出现在测试数据目录里；`~/.sideagent` 里运行期间新增或变化的非凭据文件都不含这个标记；`~/.sideagent/config.json` 前后哈希一致。— 谁检查: 样板脚本
- [x] 2. 凭据仍从原位置读取：测试伴随进程使用复制过去的日常配置，也就是同一个模型，并用它跑完任务。— 谁检查: 样板脚本（测试伴随进程日志里的模型名，以及任务结束）
- [x] 3. 没设 `SIDEAGENT_DATA_DIR` 时，所有路径和改动前一样（`~/.sideagent/...`）；已有的单项目录变量 `SIDEAGENT_TRACE_DIR`、`SIDEAGENT_DOWNLOADS_DIR`、`SIDEAGENT_ROUTE_SHADOW_DIR` 仍然优先。— 谁检查: 路径解析命令（设变量 / 不设变量各跑一次），人读 diff
- [x] 4. 每个伴随进程有自己的剪贴板服务：日常伴随进程占着 7761 时，测试伴随进程的日志里记着 `clipboard HTTP http://127.0.0.1:<另一个端口>`，没有「clipboard HTTP 未启动」。— 谁检查: 样板脚本
- [x] 5. 扩展只向自己的伴随进程请求粘贴：构建产物里不再出现 `7761`；在隔离实例里调用扩展剪贴板桥的“收尾”一步（`finish`），扩展后台发出的请求地址正是测试伴随进程日志里的剪贴板端口，返回的是测试伴随进程的「no clipboard transaction」（没有进行中的粘贴）。— 谁检查: 样板脚本。这是辅助检查：直接调用扩展里的剪贴板桥，不经过模型
  - 修订（2026-09-23，实现前）：原写法是“写入临时内容再恢复”，会把随机串写进系统剪贴板，装了剪贴板历史工具的机器会永久留下一条记录。改成只调 `finish` 并监听扩展后台的网络请求：直接看到请求去了哪个端口，剪贴板完全不动。代价是完整的“写入→页面收到→恢复”这次不验，和下面「边界与不做」里由模型发起的粘贴一样记为未跑。
- [x] 6. 样板用例：在真侧栏输入「把代号填成星河，不要保存」并按回车后，任务在 5 分钟内结束；练习页「代号」框的值是「星河」（原值「北辰」被替换，而不是接在后面）；练习站没有收到保存请求；侧栏有回复，没有错误提示。— 谁检查: 样板脚本；回复有没有把做了什么说清楚，由人看截图判断
- [x] 7. 留下可重复的产物：`out/acceptance/real-path/<时间>/` 下有 `result.json`（每项判定和证据）、侧栏和练习页截图、测试伴随进程的日志副本；重跑命令写在本文件里。— 谁检查: 样板脚本 + 人
- [x] 8. 现有检查不回退：`npm run typecheck` 通过；和剪贴板、握手相关的现有测试通过。— 谁检查: npm

## 边界与不做

- 不改日常 Chrome、日常扩展构建（`extension/dist`）和正在运行的日常伴随进程；样板用例把扩展构建到临时目录。
- 剪贴板服务没有鉴权，本机任何进程都能调用。这个问题只记录，本任务不修。
- 不做语音、故障注入和多轮对话；不对模型的措辞做断言。
- 由模型发起的真实粘贴，本次不跑（记为未跑）。
- 不删除其他会话生成的文件。

## 已知风险

- 第 5 条如果路由错了，`finish` 会打到日常伴随进程；只有你恰好在那一刻用侧栏粘贴时，才会提前结束你的那次粘贴。
- 真模型和 Jev 每跑一次都消耗额度，结果也不完全一样，所以判定只看页面、练习站和侧栏状态。

## 结果

2026-09-23：8 条全部满足。修好两个挡路的产品缺陷后，日常路径（不经任何录制或改地址）连续 2 次通过，加上经请求录制器的 1 次，共 3 次通过、0 次失败。

| 运行 | 路径 | 结果 | 任务用时 | 模型轮数 | 目标方案被拒 | 核验漏 tabId |
| --- | --- | --- | --- | --- | --- | --- |
| `2026-09-23T02-37-01-572Z` | 日常 | 失败：400 Invalid request parameters | — | — | — | — |
| `2026-09-23T02-41-06-605Z` | 录制器 | 失败：同上，定位到指针坐标 schema | — | — | — | — |
| `2026-09-23T02-53-09-234Z` | 录制器 | 失败：前两次请求 200，之后全部 Connection error. | — | 2 + 4 次错误 | 1 | — |
| `2026-09-23T02-58-52-408Z` | 录制器 | 通过 | 64.3s | 7 | 0 | 1 |
| `2026-09-23T03-04-22-669Z` | 日常 | 通过 | 68.2s | 8 | 2 | 1 |
| `2026-09-23T03-05-50-036Z` | 日常 | 通过 | 69.6s | 8 | 0 | 1 |

产物都在 `out/acceptance/real-path/<运行>-codename-no-save/`（`result.json`、`panel.png`、`page.png`、`panel-transcript.txt`、`host-data/`、`host-wrapper-err.log`）。

逐条证据（以 `03-05-50-036Z` 和 `03-04-22-669Z` 为准）：

1. 运行标记出现在测试数据目录的对话、route-shadow、trace 三类文件里；`~/.sideagent` 运行期间只变了 `everos/ingestion.json`、`everos/service.log`（日常记忆服务自己的日志，流式全文扫描不含标记，无不可读文件）；`config.json` 哈希不变。
2. 测试伴随进程日志 `Model: cliproxy/mimo-v2.6-flash`；对话记录里全部回复来自这个模型且没有 error/aborted；核验结果 `reviewedBy: "jev"`（Jev 真服务，把握 0.91–0.94）。
3. 路径解析命令设/不设 `SIDEAGENT_DATA_DIR` 各跑一次，结果与标准一致（见实现阶段记录）。
4. 日常伴随进程（PID 75750）占着 7761；测试伴随进程日志 `clipboard HTTP http://127.0.0.1:51336` 等随机端口，无「未启动」。
5. 构建产物不含 `7761`；`finish` 请求地址恰为测试伴随进程端口，返回 `no clipboard transaction`。
6. 练习页 代号=星河、项目名称=月面基地、负责人=林夏；练习站只收到 `GET /settings` 和 `GET /favicon.ico`；侧栏出现回答和「已交付」回执，无错误消息。回答写的是「已把「代号」填成「星河」，按你的要求没有点保存」——说清了做了什么，最终观感由人看 `panel.png` 裁决。
7. 见上方产物路径；重跑命令 `npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless`。
8. `npm run typecheck` 通过。`npm test` 3207 项中 2 项失败：`agent/test/task-goals.test.ts:172`、`agent/test/task-recovery-matrix.test.ts:147`，都断言 `TaskProgress` 快照标志；它们的依赖里本任务只改了 `run-trace.ts` 的默认目录，失败对应的是并行会话正在改的 `agent/src/task-progress.ts`、`shared/control.ts`。这是依据依赖关系的推断，没有撤回改动复跑。剪贴板、握手相关测试全部通过。

### 范围追加（样板用例被真实缺陷挡住，按证据修复）

- **指针工具坐标 schema**（`agent/src/tools.ts`）：`Type.Tuple` 生成的元组 schema 让 MiMo V2.6 Flash 的网关把整条请求拒成 400，只要工具列表里有 hover/click/drag 等任一指针工具，所有浏览器任务都发不出去。二分请求体定位到这类 schema；改成等价的 `{type:"array", items:number, minItems:2, maxItems:2}`，静态类型不变。修后同样 48 个工具的请求返回 200。日常对话此前没用过这个模型，所以用户还没碰到。
- **代理分流关闭共享连接池**（`agent/src/main.ts` `createProxyDispatcher`）：配置了 `proxy` 时，外层 `Agent({factory})` 给所有本机地址返回同一个共享 `Agent`。undici 8.10.1 在某条连接断开、它看起来空闲时会 `close()` 工厂返回的对象（`node_modules/undici/lib/dispatcher/agent.js` 95–133 行），之后所有本机模型请求都 `UND_ERR_DESTROYED`，模型侧报 `Connection error.`，重试无效。定点复现：旧写法 `200 → 失败 → 失败`，改用 undici 自带的 `EnvHttpProxyAgent({httpProxy, httpsProxy, noProxy:"localhost,127.0.0.1,::1"})` 后 `200 → 200 → 200`；另用假代理确认外网 http/https 仍经代理、本机直连。日常配置里有 `proxy`，日常伴随进程走的是同一段代码；不过日常 `wrapper-err.log` 里只有 2 条早期的「模型请求最终失败：Connection error.」，不足以说明用户已经碰到过。

### 发现但未处理

- 目标方案被拒的提示有误导（`agent/src/task-goals.ts:96`）：真实原因是「field 目标引用的 materialId 在同一方案里没有对应的 material 目标」，提示却笼统列出所有规则，其中两条模型已经做到。模型只能靠猜，在 4 次有效运行里 2 次因此多花 1–2 轮。
- 核验漏 `tabId`：3 次通过的运行每次都先被「核验缺少 tabId」拒一次，固定多一轮模型调用。
- 7 个比 `.ts` 旧的未跟踪 `shared/*.js` 被 esbuild 打进扩展（`shared/control`、`execution-feedback`、`network`、`observe`、`pointer-input`、`protocol`、`task-view`）；tsx 优先 `.ts`，所以伴随进程不受影响，扩展受影响。来源是其他会话，本任务不删。
- 旧验收脚本 `scripts/acceptance/program-run.mjs`、`recovery-run.mjs` 用了同样的共享工厂写法；两者是 9/07 的一次性脚本，已在[仓库清理](20260923-repo-cleanup.md)中删除。
- 剪贴板服务无鉴权（同「边界与不做」）。
- **日常扩展构建目录不见了**：日常 ChromeMain（`Default/Secure Preferences`）从 `extension/dist` 加载扩展，收尾时这个目录不存在；`extension/` 目录修改时间 10:06:29，早于本任务第一次样板运行（10:37）。本任务只经 `SIDEAGENT_BUILD_DIST` 构建到临时目录，构建前后的日常 dist 检查也是在它已缺失时做的，所以没能发现；删除者未查明。没有重建：那会写日常目录，并把并行会话未完成的改动和 7 个旧 `.js` 打进日常扩展，交用户决定。

### 未跑

- 由模型发起的真实粘贴；剪贴板「写入→页面收到→恢复」全流程（见第 5 条修订）。
- 语音、故障注入、多轮对话。
