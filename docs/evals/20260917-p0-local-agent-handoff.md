# P0 实机验收交接

## 已确认的分工

> 2026-09-18 更新：开发阶段不再转交本地 Agent，当前 Chat 直接通过 DevSpace 修改和验证。后续付费实机也由当前 Chat 在用户明确授权实际模型与预算后执行。本文件保留历史场景、命令和判定口径；执行前先读[复测裁决与当前实现](20260917-p0-retest-adjudication.md)，旧模板和旧证据不代表当前源码通过。

2026-09-17 用户要求先完成 P0 开发，再由本地 Agent 做真实模拟用户测试。当前主代理已完成本地实现、确定性回归与测试准备，**没有启动真实 Chrome 或调用产品模型进行这一轮实机验收**。本文件不能代替用户对模型预算、隔离环境和实际执行范围的授权。

> 执行结果（2026-09-17）：本地 Agent 已按本文件完成 12 场景实机执行：**11 PASS、1 FAIL、0 BLOCKED/NOT_RUN**。
> 报告与原始证据：`out/acceptance/p0-local-agent/`；记录：[P0 本地 Agent 实机验收](20260917-p0-local-agent-acceptance.md)。
> FAIL 为 host-restart 第三次重启后检查点被静默丢弃（程序步骤 toolCallId 含 `/`），根因与复现见 `out/acceptance/p0-local-agent/cases/host-restart/analysis.md`。

先读 `AGENTS.md`、`docs/STATUS.md` 和当前 Git diff。已有翻译修复与 P0 改动仍在工作树，不能 reset、覆盖或根据旧文档退回旧实现。代码已变更时必须重新取证；不能用先前构建的截图或测试数字作当前版本的通过证据。

## 三个入口

在项目根目录执行：

```sh
# 不启动浏览器或模型：确定性回归、持久化与测试站点自检。
npm run test:p0

# 只启动 127.0.0.1 上的虚构站点；终端输出实际端口。
# 不访问日常账号，不发出真实报名、付款或消息。
npm run fixture:p0

# 创建全部为 NOT_RUN 的报告。已有同名报告不会被覆盖。
npm run eval:p0 -- --init out/acceptance/p0-local-agent
```

如果主代理已经创建该目录，可继续填写其 `results.json`；若代码或场景发生变化，新建另一个 `out/acceptance/` 子目录，保留旧证据。开始实机测试前，运行下面的校验命令确认代码指纹匹配；未跑报告返回 NOT_RUN 和退出码 2 是正常的，绝不是通过。

```sh
npm run eval:p0 -- --verify out/acceptance/p0-local-agent/results.json
```

## 环境约束

使用单独的浏览器 profile、测试扩展和 native host 存储目录。浏览器必须 `--headless=new`；不得接入日常 Chrome、杀掉所有 Node/Chrome 进程、重载日常扩展或复制真实凭据进证据目录。确认模型调用预算后再运行产品模型。缺少预算、凭据或隔离环境时记录 BLOCKED，不调用其他开发子代理替代它。

宿主故障只终止本轮创建并记录了 PID 的测试进程；测试站点应独立运行，避免杀掉站点后误以为副作用消失。断连、暂停和取消不是相同事件：分别检查持久化检查点、页面控制权与模型是否再次启动。

## 场景与故障注入

逐项执行 `eval/p0/cases.json` 中 12 个场景。它们是公开的开发验收场景，**不是独立留出集**；本地 Agent 还需加入未参与实现的任务或表达变体，单独记录，不能将拟合固定场景的通过率称为泛化能力。

测试站点提供三份独立方案页、原表单 `/form`、另一张表单 `/other`、模拟登录页 `/login` 和只读状态 `/api/state`。使用虚构姓名。表单保存写入的是这个本机测试进程的内存记录，状态中可核对保存次数、重复保存与错页保存次数。

回执丢失由测试者对 `/api/fault` 发送 JSON `{"dropNextReceipt":true}`：下一次保存先记入服务端，再断开响应。必须保留这次注入前后的 `/api/state` 证据；不能因为浏览器报错就判定没有写入。测试者可向 `/api/account` 发送 `{"account":"B"}` 更换模拟账户，再刷新页面；这不是原任务 Agent 可自行制造的验证结果。

`host-restart` 至少覆盖准备页面时、写入派发后尚无回执时、已确认写入后这三个边界。`aged-checkpoint` 使用老检查点重建场景时，在 notes 中说明时间老化是模拟；不得写成真实隔夜运行。每个场景前重启虚构站点或启动独立实例，避免将上一个场景的计数混入本场景。

## 每项必须留下的证据

报告中填真实起止时间、原 runId / 恢复后的 runId、使用的模型、预期结果是否满足、副作用次数、重复/错页写入、恢复失败和用户纠正次数。需要保留同任务的场景，前后 runId 必须一致；遇到无法确认的操作，安全结果是保留未知并停止重复写入，不是强行把任务做成成功。

每项 PASS 至少有一份 trace 和一份 state 原始证据。证据文件放在报告同目录或其子目录，先检查并脱敏，再计算 SHA-256 填入报告。trace 应含用户原话、调度回执、工具事实、停止/续接事件；state 应含页面 DOM/截图或测试站点状态，能与 trace 对上。不要只贴一段 Agent 自评。

校验工具拒绝漏项、重复编号、改用新任务身份、关键错误次数非零、代码/场景指纹不匹配以及证据缺失/校验和错误。它只检查报告完整性和声明的硬指标，**不会独立判断轨迹是否真实、截图是否充分或答案是否正确**；这些仍由执行者和复核者核对。P0 校验通过也不替代仓库已有发布门槛。

## 特别关注的实现边界

恢复先核对保存的 URL 指纹，再取得新页面读数；同 URL 的重新打开标签可以继续核对，不同 URL 不会接着填写。页面身份缺失时不能猜测，旧版本检查点缺少原附件或任务级输入时也不得伪造恢复。

未知写入与未留下可追踪回执的辅助脚本会保留不确定性，继续只允许观察或如实交付部分结果，不构成再次写入的授权。不同选择器、不同脚本是否实际重复同一业务动作，仍没有通用语义去重证明。已确认动作的保守防重可能阻止合法的重复控件操作；请用真实任务验证并报告，不通过删除保护来让用例变绿。

登录失效、同 URL 换账号不能仅凭 URL 指纹识别账户；需要核对当前页面显示的身份，并保留必要的人类确认。检查点不会恢复旧授权票据。真人感受、语音首声和完整跨页成功率也未由本轮单测证明。

最终分别给出：实际通过、实际失败、BLOCKED、NOT_RUN，以及可复现步骤。修复后重新构建、重测受影响场景并保存新证据；未经用户授权不提交、推送或发布。

## 第二批复测：接收持久化与有边界确认（2026-09-18）

当前源码的新证据目录（模板已建，不覆盖）：`out/acceptance/p0-chat-retest-20260918/`，指纹 `894c5936dabe…`。跑前核对指纹：`npm run eval:p0 -- --verify <报告>` 应为 NOT_RUN / errors=[]。需用户先明确授权本次实际模型与预算；旧报告和 `p0-local-agent-retest-20260918` 的旧模板都不得混用，旧 11/12 不能冒充本轮通过。

```sh
# 1) 受影响 5 项，语音入口；确认卡片由驱动作为模拟用户放行
npx tsx scripts/acceptance/p0-local-agent-run.mts --headless --write-consent allow \
  --report out/acceptance/p0-chat-retest-20260918 \
  --case host-restart --case extension-reload --case receipt-loss --case resume-cancel --case attachments-corrections

# 2) 同样 5 项，真实侧栏输入框 Enter
npx tsx scripts/acceptance/p0-local-agent-run.mts --headless --resume-entry text --write-consent allow \
  --report out/acceptance/p0-chat-retest-20260918/text-entry \
  --case host-restart --case extension-reload --case receipt-loss --case resume-cancel --case attachments-corrections

# 3) 接收回执后、模型首条输出前立即杀宿主
npx tsx scripts/acceptance/p0-local-agent-run.mts --headless --variant accept-kill \
  --report out/acceptance/p0-chat-retest-20260918/accept-kill --case host-restart

# 4) 最新检查点损坏
npx tsx scripts/acceptance/p0-local-agent-run.mts --headless --variant corrupt-checkpoint \
  --report out/acceptance/p0-chat-retest-20260918/corrupt-checkpoint --case host-restart

for r in results.json text-entry/results.json accept-kill/results.json corrupt-checkpoint/results.json; do
  npm run eval:p0 -- --verify "out/acceptance/p0-chat-retest-20260918/$r"
done
```

判定口径：三份受影响场景应完成业务目标并读回；仍以“请用户确认”停车视为未完成，另记 FAIL，不修改场景期望。`write_consent_seen` / `write_consent_decision` 应出现在 trace；面板放行优先（`via:'panel-card'`），端口兜底才记 `panel-port`。接收后立即杀宿主：重启必须恢复原 runId、完整要求与附件，同请求重发不重复启动。
