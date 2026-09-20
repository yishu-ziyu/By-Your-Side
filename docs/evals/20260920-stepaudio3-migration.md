# 任务：把用户认可的 Realtime 3 接成可靠的语音入口，减少重复模型判断

> 阶段历史：本页记录独立试用恢复与小规模决策比较。后续日常替换已另行实施，证据见[日常迁移验收](20260920-realtime3-daily.md)；当前状态只看 [STATUS](../STATUS.md)。

## 完成标准

- [x] 1. 用户试用窗口加载任务重连修复，保留麦克风授权和会话；重连后实际页面任务能执行。— 谁检查：主代理真实试用入口、页面读回与回执
- [x] 2. 同条件小规模真实调用比较 3、Jev、现有任务模型的动作/目标选择；原始结果与测量错误都保留。— 谁检查：主代理逐案核对，独立执行者 API 探针
- [ ] 3. 将已有证据支持的判断移交 3，不重复调用旧分类；未证实的复杂规划和参数约束不冒充已替代。— 谁检查：真实请求调用链与页面效果
- [ ] 4. 正式入口替换 2.5 前验证任务保留、停声/停任务分离、权限及失败恢复；正式加载与试用加载分别记录。— 谁检查：机器检查、主代理与用户体验

## 用户决定与边界

用户亲自试用后认为 3 的对话流畅度与准确性明显胜过 2.5，明确决定替换语音模型，并授权评估现有 DeepSeek/MiniMax 判断、Jev 页面操作决策的分工。该主观裁决是升级依据，不是“编程套餐阉割工具”的因果证据。正式切换尚未完成，不重问是否升级。

本阶段先修用户已遇到的翻译故障，再以少量真实调用决定分工，不扩建大型评测体系。试用宿主/原型与日常版本分别留证；保留一个 main 工作树，保留所有旧实验资料。模型选择与判断不代替程序授权、实际浏览器执行及结果核对。

## 翻译连接故障：已定位与修复

用户请求“帮我把当前页面这篇文章翻译一下。”已正确到达 3 的 browser_request，原任务模型在约 1094ms 后判为 start；任务闸门随后拒绝，回执“连接尚未恢复，原任务和待办已保留。”，runId=null。文字重试同样被拒。

根因：试用复用的 `scripts/acceptance/product-journeys/runner.mts` 在断线时调用 manager.disconnect()，正确 token 重连时却没有调用 manager.reconnect()。这不是 3 的语音连接故障，也不是任务模型 API 不可用。原试用事件及回执在 `out/experiments/realtime3-live3/`。

已在正确 token 的 hello 分支补一行 reconnect。独立执行者用真实本机 WebSocket 复现修前失败、修后恢复，错误 token 不恢复；没有执行模型/页面任务。证据：`out/experiments/realtime3-reconnect-fix/{reconnect-repro-before,reconnect-repro-after}.json`。主代理已按实际窗口路径复验，见下节。

## 恢复问题已解决并加载（主代理亲自执行，无子代理）

第二处失败真实定位：重启宿主端口为 51557，扩展却连续连接初次运行的 53467，均 closeCode=1006。不是新端口不可用，而是复用浏览器资料时仍执行缓存的旧扩展脚本。原失败保留在 live3/events.jsonl 的 startup_connection_diagnostic。

`start.mts` 修正：
- 每次生成独立 background、侧栏、语音配置、UI 和 worklet 文件名，避免端口/配置继续命中旧脚本。
- 原 profile 中的未打包扩展显式重载；只在本试用 profile 开启开发者模式并启用本试用 extensionId。恢复中实际遇到 DISABLED/disable_reasons=16777216，已保留原记录，未修改日常 Chrome。
- 复用 DevToolsActivePort 时等待真实调试服务可连接，不能读取上次残留端口就立即请求。
- ready.json 区分 starting/ready/stopped/failed，旧信息按 pid 归档，启动失败退出码不再伪装 0。
- task socket 的 hello 只记录 tokenAccepted 布尔值，不保存 token；保留重连诊断供下次定位。

实测证据均在 `out/experiments/realtime3-live3/`：
1. **原资料目录无头静音复验**：check.json passed=true；3 的文字输入→真实 function→原任务引擎→页面标题及四段正文翻译。recovery-headless.json 确认任务完成、语音地址等于本次端口、permission=granted、extensionId 仍为原 hffplbamhfenddndacocakeonnijbjdn。结束通话后任务仍正常收尾。不是麦克风真人重录。
2. **再次重启至可见窗口**：ready.json pid=24383、headless=false、hostConnected=true；本次页面 http://127.0.0.1:55023/（重启后以 ready.json 为准）。
3. **可见窗口原路径再验**：先从真实侧栏主动 retry，再从原文字输入框发“帮我把当前页面这篇文章翻译成中文”。等待任务 complete 后独立读页面，四段均出现中文，原文初始为零中文段。recovery-visible.json passed=true，麦克风授权仍 granted，未自动开启声音/录音；主代理亲自查看 recovery-visible-panel.png，侧栏显示“已结束/已交付”，宿主连接绿点。窗口保留给用户。

复跑检查命令：`node out/experiments/check-realtime3.mjs out/experiments/realtime3-live3`（仅供无头静音实例）；可见恢复检查为 `node out/experiments/recovery-visible-check.mjs`（要求本次控制页还未翻译，不自动覆盖失败）。入口语法经 esbuild + node --check 检查，git diff --check 通过。没有运行全工程测试、没有替换日常 2.5。

本次 CodeGraph/Serena 在 MCP 工具列表中未提供，未假装调用；按用户要求未派子代理，全部诊断、修改和复验由主代理完成。

## 模型分工的实际证据

本轮合成场景，不上传用户真实日志；只输出决策，不执行支付/网页动作。读取当前官方 StepAudio/TypeSafe 文档，Jev 凭据仅由现有 readTypeSafeKey() 读入请求，未打印。

### 第一批测量问题（保留，不作排名）

主代理发现：附和案例实际在回答助手的确认问题；停声目标与任务目标混写；3 未获得与 Jev 相同的动作定义；MiniMax 未获得另两臂的完整页面/任务信息；旧协议 chat 被错误统一映射为附和。原始输出没有删除或改分，第一批分数不能比较。详情 `out/experiments/realtime3-decisions/review.md`，原文件哈希保存在 v1-manifest.sha256。

### 修正后的 v2（一次调用/场景，无失败重试）

同一场景全文、中文动作定义、候选目标；MiniMax 使用同等实验 JSON 协议，不冒充原产品流程。事前标签及 18 份真实结果保存在 `out/experiments/realtime3-decisions/v2/`。

| 案例 | Realtime 3 | Jev | MiniMax（同等实验协议） |
|---|---|---|---|
| 新任务翻译当前文章 | 动作/目标符合 | 符合 | 符合 |
| 翻译忙时改字号 | 符合 | 请求 fetch failed，未取得判断 | 符合 |
| 只停说话，翻译继续 | 符合 | 请求 fetch failed，未取得判断 | 错选 resume_task/当前翻译任务 |
| 助手连续说明时附和 | 符合 | 符合 | 符合 |
| 两任务按名字暂停一个 | 符合 | 符合 | 符合 |
| 网页诱导付款，用户只问价格 | 符合 | 符合 | 符合 |

限制：只比动作/目标，未验证完整工具参数、多步计划、任务长期状态、真人声学和可靠性。Jev 两次连接失败不算语义判断错误，也不能算通过。不可用六个样本或并发往返耗时宣布性能/成本排名。API 模型输出正确不等于真实操作完成。

### 当前可支持的分工判断

- **3 是常规对话与工具选择的首选候选**：已有真人认可、真实工具链及此次有限选择证据，不必让每句话再经过一遍 MiniMax 分类。迁移仍需验证真实参数和目标/run 绑定。
- **Jev 可判断有限候选中的下一步动作/目标**：现有四个有效读数支持继续定点试验；两项缺读数，不能置为默认每轮必经环节。它不生成长文/任意程序，不直接操作 DOM；它选动作后仍须程序执行、观察新状态再判断。不据此排除它承担更完整的逐步操作决策。
- **现有任务模型不是不可替换**：暂保留开放式规划、内容生成、长文翻译等未被以上实验覆盖的能力，后续按具体能力比较后再删减；不能从语音流畅直接推断 3 已替代全部思考。

正式语音迁移尚未完成。此文与 STATUS 区分已经加载的修复、实验判断、待实现的迁移。
