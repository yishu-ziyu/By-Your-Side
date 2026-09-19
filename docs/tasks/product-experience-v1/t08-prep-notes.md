# T08 预备调研：首次使用与可回退试用（只读盘点）

- 分支/基线：worktree `t08-prep`，基线 `04f212a`。T01 修复已合入但 review 第二轮未结；T02 已合入；T03–T05 分支与基线同点（仅认领无提交），T06/T07 无分支。T08 整体验收依赖未齐。
- 方法边界：只读走查代码与机器现状，加一次 `npm run doctor`。未构建、未改任何配置、未加载/重载扩展、未调用模型。文中「现状」指本机 `04f212a` 对应代码，不外推为集成后行为。
- 首次使用路径按 README `README.md:53-121` 的五步走查：准备环境 → 配置任务模型 → 加载扩展 → 可选语音 → 可选 Jev。

## 安装卡点

1. **安装后不重启 Chrome，会误报「native host 未安装」并把人引去吃 token。** Chrome 只在启动时扫描 NativeMessagingHosts；重启提醒只出现在安装脚本的终端输出（`scripts/install-host.mjs:106`），README 的加载扩展步骤（`README.md:89-95`）没有这条。连不上时扩展先回退 WS 调试通道（`extension/src/background/uplink.ts:129-140`），无 token 最终给用户的原文是「…且未配置 ws 调试 token。安装 native host（npm run install:host）或在面板设置 token」（`uplink.ts:150-157`），并在面板冒出调试设置页（`extension/src/sidepanel/main.ts:3014-3022`、`3125-3141`）：明明是「已装未重启」，提示却是「未安装」+ npm 命令。
2. **host 清单与 wrapper 是全局共享的绝对路径，worktree/多 checkout 会互相顶替。** wrapper 写死 `process.execPath` 与本仓库 `agent/src/main.ts`（`scripts/install-host.mjs:40-45`），清单写到标准 user-data-dir 及当时在跑的自定义 user-data-dir（`install-host.mjs:62-93`）。本机现状：`~/.sideagent/native-host.sh` 实际 exec 的是主 checkout `~/Desktop/AI 产品/By-Your-Side`，不是本 worktree；若从本 worktree 跑 `install:host`，又会把日常 host 指到本处。doctor 查不出这种「清单存在但指向别处/路径已失效」（`scripts/eval/doctor.mts:44-54` 只看 name/origins/path 高低位，不校验路径存在与指向）。首次使用验收若要隔离，必须用独立 HOME/user-data-dir，否则会污染日常环境（见文末顺序）。
3. **Node 版本口径不一致。** README 要求 22.19+（`README.md:58`），doctor 只查主版本 ≥20（`scripts/eval/doctor.mts:27`）。
4. **缺任务模型凭据时，界面先显示「已连接」，用户不知道缺什么，直到发送第一条任务才收到开发者式指引。** host 正常连接即亮绿灯（`extension/src/sidepanel/main.ts:2998-3000`），`hello_ok` 允许无 model 下发（`agent/src/main.ts:169-171`）；模型芯片此时只显示「选择模型」（`extension/src/sidepanel/models.ts:60-61`），打开列表是「暂无可用模型」（`extension/src/sidepanel/model-picker.ts:181-183`）。发送后错误正文是 `SETUP_GUIDANCE`（`agent/src/session.ts:156-158`，触发点 `session.ts:675-683`），要点是「运行 `npx @earendil-works/pi-coding-agent` 并 /login，或设 ANTHROPIC_API_KEY / OPENAI_API_KEY」——没有产品内配置入口，也没有「这是缺凭据，不是助手坏了」的分层。
5. **模型选择器有 5 个 id 的白名单。** `agent/src/reachable-models.ts:9-16` 只放行 MiniMax M3、Grok 4.6、MiMo V2.5/V2.5 Pro、DeepSeek Flash（外加当前模型）。新用户按 README 在 Pi 里登录了别的 provider，模型列表也几乎空。
6. **面板切换模型不落盘，重启/回退后回到默认。** `set_model` 只改会话内模型（`agent/src/conversation-runtime.ts:67-78`）；`saveConfigModel` 无生产调用（`agent/src/config.ts:55`，只有 `agent/test/config.test.ts:5,62-76` 用）。用户看到「已切换」，下次 host 重启后模型名变回去，容易被当成升级/回退把配置弄坏了。
7. **配置写错静默。** `loadConfig` 对缺失/坏 JSON 一律返回空配置（`agent/src/config.ts:24-40`）；只有到建会话解析 model 时才报错（`agent/src/session.ts:529-538`），再被包成初始化错误塞进 `guidanceMessage()`（`session.ts:1607-1609`）。
8. **语音 key 的真实路径只此两处**：`SIDEAGENT_STEP_PLAN_KEY` 或 `~/.sideagent/step-plan.key`（`agent/src/voice-service.ts:12-20`）；文件权限不足或缺失都吞成同一句「请先配置本机 Step Plan 语音 Key，再重试。」（`voice-service.ts:21`、`voice-service.ts:84`），没有配置入口链接。
9. **符合契约的现状（可省力）**：首次建议只填空草稿、已有草稿不覆盖、不自动发送（`extension/src/sidepanel/main.ts:162-167`、`425-436`）；语音/Jev 缺失都不阻塞文字链路（`agent/src/display-fast-path.ts:83`）。

## 诊断缺口

- 入口：`package.json:31`（`doctor` → `scripts/eval/doctor.mts`）。脚本全文只读（existsSync/readFileSync/execSync ps+版本号），未写配置、未动网页；不打印密钥。本次实测 8 OK / 5 BLOCKED / 0 FAIL，退出 0；BLOCKED 不计失败（`doctor.mts:89-93`）。
- **语音检查项变量名与产品不一致，会出现假 OK/假 BLOCKED。** doctor 读 `STEPFUN_API_KEY`/`STEP_API_KEY`，并暗示「may still live in ~/.pi」（`doctor.mts:66-67`）；产品实际读 `SIDEAGENT_STEP_PLAN_KEY` 与 `~/.sideagent/step-plan.key`（`voice-service.ts:12-20`）。本机 shell 恰好设了那两个变量，doctor 报 OK，但产品根本不读它们；反之只按 README 放好 key 文件时 doctor 会误报 BLOCKED。
- **model_credentials 只证明 `~/.pi/agent/auth.json` 文件存在**（`doctor.mts:60-61`）：覆盖不了 env 凭据（`session.ts:157-158` 自己提示的 ANTHROPIC_API_KEY 等）；不校验 `~/.sideagent/config.json` 里配置的 model 是否能被该凭据使用；不测网络/额度/服务端可达性，也没有一次最小往返探针。
- **native host 只查标准 user-data-dir 的清单**（`doctor.mts:44`）：Chrome 以自定义 `--user-data-dir` 运行时（安装脚本会另外写该目录，`install-host.mjs:62-83`），doctor 会误报未装/漏报装了。
- **缺 Node 没有判因。** wrapper 里的 node 绝对路径失效时（`install-host.mjs:45`），Chrome 报英文 `Native host has exited.`，扩展原样透传再拼上 npm 命令（`uplink.ts:129-140`、`150-157`）；不会说「Node 路径变了，重跑 install:host」。doctor 的 node 检查只在能跑起 doctor 之后才有意义（`doctor.mts:27`）。
- **网络失败、凭据失效、模型不存在、限流没有分开报。** 模型错误统一走 `模型请求最终失败：${errText}`（`agent/src/session.ts:1867-1871`），只有 404/Not Found 被改写成人话（`extension/src/sidepanel/models.ts:89-95`），其余是原始英文。A08-02 要求「网络失败、错误模型、断开本地进程分别说明，不统一写账号错误」——目前未达标。
- doctor 不检查：npm ci 是否完成（它是能跑 doctor 的前提）、`~/.sideagent/typesafe.env`、扩展是否真的加载、Chrome 重启后 host 能否拉起、wrapper 指向是否当前候选。

## 安全观察

- 密钥文件权限正确（样本：`~/.sideagent/step-plan.key`、`typesafe.env` 均 600）；日志可读面更大：`agent.log`（1.0 MB）与 `wrapper-err.log`（3.0 MB）是 644，目录 755，且没有轮转。
- 现有日志未发现凭据样本：对两日志 grep `Bearer …|sk-…` 计数 0/0。只证明当前样本，不等于所有错误路径都干净。
- 进入模型的页面内容与工具回执过 `redactCredentialText`（`shared/untrusted.ts:54-78`，用于 `agent/src/tools.ts:225,325,479,496` 等）；抓取请求头有掩码（`agent/src/fetch-consent.ts:22,68-71`）；运行轨迹落盘前过 `sanitizeTrace`（`agent/src/run-trace.ts:13-20`，应用点 `run-trace.ts:153`）。这些自述均为 best-effort（`run-trace.ts:19`：无法识别无标签的任意密钥）。
- 未全覆盖的路径：`log()` 把消息原文写 stderr/日志（`agent/src/main.ts:109-116`）；`emitError` 把 `err.message` 直接送面板（`agent/src/session.ts:1611-1614`，例外是模型错误 `reply.errorMessage` 会先 redact，`session.ts:955`）。本次未构造触发样本，不能宣布 0 泄露；A08-02 应把「错误凭据/网络失败同时 grep 界面和两个日志」列为证据动作。
- 调试 token 输入框是 `type="text"`（`extension/src/sidepanel/main.ts:243`），会明文回显存在 chrome.storage 的 WS token；仅调试通道相关。
- 语音录音只在诊断/显式 capture 模式下持久化，并按天数与体积自动清理（`agent/src/voice-capture-store.ts:99-101,216-240`）；回退验证要留证需先拷贝。

## 回退风险

- **数据无版本、无迁移、无自动备份。** 全部运行数据在 `~/.sideagent/`（`agent/src/main.ts:143-146` 的 conversations/memory/experiences/skills/task-receipts，加 logs、downloads、voice-capture、traces），机器上的 `~/.sideagent/backups/` 只是 2026-09-10 一次人工清空的历史产物（`docs/evals/20260910-panel-history-quota.md:10,49`），不是升级前备份。仓库没有升级/回退脚本或文档。
- **会话索引损坏会静默清空列表。** `ConversationStore.load` 解析失败直接 `return []`（`agent/src/conversation-store.ts:14-20`）：升级写入新格式 `index.json` 后回退旧版，面板可能表现为「会话全没了」（单会话 Pi JSONL 文件仍在磁盘，但列表与恢复入口看不到）。这是回退最可能安静发生的数据面损伤，A08-07 必须覆盖。
- **schema/协议门禁只拒绝、不降级。** `PROTOCOL_VERSION`/`STORAGE_SCHEMA_VERSION` 均为 1（`shared/protocol.ts:15-16`）；不匹配即 `hello_error` 并退出 host（`agent/src/main.ts:244-256`），文案「请升级后重试」对「回退降级」方向是误导；扩展收到 `hello_error` 停自动重连、弹调试设置页（`uplink.ts:88-91`、`extension/src/sidepanel/main.ts:2913-2915`）。没有「先备份、说明不可逆部分」的实现。
- **回退到不同目录要重跑安装且完全重启 Chrome**（`install-host.mjs:40-45,106`）；doctor 不校验 wrapper 是否当前候选，回退后可能悄悄跑着旧 checkout 的 agent（见安装卡点 2）。
- **模型选择不落盘**（`conversation-runtime.ts:67-78`）：升级/回退/重启后模型回默认，容易误读为版本问题。
- 回退友好的一处：面板历史兼容旧存储格式（`extension/src/background/panel-history.ts:10-17`），chrome.storage 数据不随扩展重载清空。
- 音频记录自动按天删除（`voice-capture-store.ts:216-240`）：跨天做 A08-07 会丢中间证据，需先拷贝。

## 给 T08 的建议验收顺序

0. **先隔离，再碰安装**：用独立 HOME 与独立 user-data-dir 跑 `npm run install:host`（macOS 上 `home` 由 `$HOME` 决定，wrapper 与标准目录都会随 HOME 走，`install-host.mjs:40,59,76`），避免顶替日常 host；候选自干净 worktree 构建（`npm ci && npm run build`），记录 commit。
1. **A08-08 候选核对**：commit、开关（displayFastPath 默认关、语音/Jev 可选）、`npm run check`、doctor 输出同候选留档；doctor 的 git 行已含 sha（`doctor.mts:37-39`）。
2. **A08-01 先单人走通**：按 README 五步从零安装到首任务；专门验证「安装→完全退出 Chrome→重开→连接」这一步（当前说明缺口见卡点 1）。
3. **A08-02 注入矩阵**：缺 Node（改坏 wrapper 的 node 路径）、缺 host、缺凭据、错误凭据、网络失败分别注入，记录面板原文、日志与「下一步是否真实可做」；同时执行安全项（界面与 `agent.log`/`wrapper-err.log` grep 密钥样式）。
4. **A08-03 可选能力**：在隔离 HOME 内移走 `step-plan.key`/`typesafe.env`，确认文字任务照常、只标可选不可用；顺带记录 doctor 语音假阳性（`doctor.mts:66-67`）。
5. **A08-04 草稿契约**：现成行为已达标（`extension/src/sidepanel/main.ts:425-436`），补建议点击、删改、取消发送三组证据即可。
6. **A08-07 升级/回退（隔离 HOME）**：先整体拷贝 `~/.sideagent` 作备份；升级到冻结候选后读旧会话；再回退旧 commit → 重新 `npm ci`/`npm run build`/`install:host` → 完全重启 Chrome；核对旧会话可读、无自动重放、配置与数据未被清，并保留回退前后 `conversations/index.json` 与单个会话文件的哈希/内容对比。
7. **A08-05 五人样本**：测试前先定样本；环境不满足者另列，不事后剔除。
8. **A08-06 24 任务**：在冻结候选上用 `npx --no-install tsx scripts/acceptance/product-journeys.mts --headless --suite full`（入口 `scripts/acceptance/product-journeys.mts:1-54`；缺 dist 或模型不可用会在开跑前 exit 2，不能拿它当产品结论）；该套件使用隔离面板 + 独立 host（`product-journeys.mts:20,53-54`），与 A08-01 的真机首用分别留证。

> 依赖提醒：T03–T07 未合入前，本票只能做到「安装/回退手工清单 + 注入脚本设计」，A08-05/06 与完整 `npm run check` 需等集成冻结后重跑。
