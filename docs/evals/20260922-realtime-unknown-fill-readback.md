# 任务: Realtime 直连 fill 的 unknown 回执附带一次受控原字段核查

## 完成标准

- [x] 1. 修前复现 unknown fill 无附属读取；修后真实 BrowserAgentSession → createBrowserTools → ToolRpc → 内存扩展 → Realtime function_call_output 贯穿一次读取。— 谁检查: 定点 Vitest
- [x] 2. 原 tab/document/target 来自写前成功 read_element 的实际结果，在原 fill 派发时绑定；身份不足、保护字段、任务失效或文档变化不读错对象。— 谁检查: 宿主与扩展定点测试
- [x] 3. 期望值、空值和不匹配值均可为成功观察；原 fill 仍 reject/unknown，写入限制不解除，合法迟到回执仍可恢复。— 谁检查: 真实任务进度回归
- [x] 4. 附属读取最多一次，复用注册工具及事件，不释放原占用，不伪造 provider call_id；取消和有界超时进入实际执行链。— 谁检查: 贯穿与边界测试
- [x] 5. JSON 超长仍保留原事实与读取状态；无额外成功反馈，不改变通知渠道。— 谁检查: 结果序列化及通知/反馈回归
- [x] 6. typecheck、architecture、diff 检查，独立列出验收依赖既有错误。— 谁检查: 实际命令

## 边界与不做

- 仅 Realtime 直连 fill；其他工具不增加恢复分支。只读当前值，不 expect 轮询、不重试、不重放、不确认写入、不更改 Goal 判定。
- 不以超时后的当前文档冒充原文档。普通 snapshot 不足以判断字段保护属性；没有完整字段观察则跳过。
- 不改模型、prompt、路由、持久化 schema；无真实模型、麦克风、浏览器服务试跑或新增八次预算。
- 保留并行工作；不 commit/push/重载日常产品。完成后停止，待独立 review。


## 结论与证据边界

已实现并通过离线贯穿，未加载日常：身份完整的 Realtime fill 收到宿主 unknown 后，不依赖模型再发工具调用，追加最多一次只读核查。原调用仍 reject；读取成功也不解除 unknown、不重放、不标记 Goal satisfied、不额外发成功胶囊。

**覆盖限制：本轮要求写前已有成功 read_element 的完整字段身份与保护属性；仅普通 snapshot 的路径仍 skipped。** 没有用当前 documentId 补齐原身份。因此修复的是身份可核对时的有界恢复，不宣称原 C2 的 snapshot-only 路径或真实模型语言已经修好。前四切片的独立 review 完成由用户本轮确认；原八次实验不改、不追加预算。

主证据：[贯穿调用与实际出站结果](../../out/acceptance/realtime-unknown-fill-readback-20260922/through-path-final-checked.json)，[检查记录目录](../../out/acceptance/realtime-unknown-fill-readback-20260922/checks/)。模型和扩展传输模拟，BrowserAgentSession、ConversationManager 的任务账本、createBrowserTools、ToolRpc、RealtimeVoiceSession/连接层及序列化均执行真实代码。原字段身份经正常读取回执进入 RPC，未手写宿主缓存、未把三类 ID 写成同一个值。扩展的读取、文档门禁另用真实 readElement/观察代码及模拟 Chrome API 检查。

## 原身份来源与执行边界

1. 写前 read_element 的真实结果给出 tabId、documentId、target、tagName、anchorSource.type/autocomplete。documentId 在扩展来自 InjectionResult.documentId 或 withObservedDocumentIdentity 的前后文档核对；不是 URL、选择器或事后 active tab。缺字段、缺文档、截断或缺保护属性不建立自动核查身份。
2. ToolRpc 在既有、有上限的 dispatched 记录中仅保留该读数的身份和保护标记，不保留字段正文。Realtime 直接 fill 才启用准备标记；派发时读取实际解析后的 tab/target，绑定同页最近已完成字段读数的宿主/传输 ID。不是用同名工具或数组位置关联回执。
3. 原 fill 的出站帧附宿主生成的 expectedDocumentId。扩展在入口和写入边界复核；DOM 写入限定 documentIds，AX 写入解析节点后再检查文档。该参数不向 provider 暴露，也不能由 provider 伪造传入。
4. 原 fill unknown 后仍持有 displayWork；不递归公共入口。附属 read_element 经原注册工具、控制/任务检查和事件发出，使用新的 display ID 和 RPC 随机 ID。原 ID 仍专属于 fill。
5. 读取带原 documentId 和 1500ms 绝对截止时间；adapter 把剩余时间传入真实 RPC timer 和取消信号，扩展在异步边界、文档检查及页面函数入口检查截止时间/控制有效性，DOM 读取限定原 documentIds。只读 value，不 expect、不轮询、不 retry；没有 Promise.race 留下自行循环的恢复操作。原 fill 的 30000ms 超时未改。
6. 取消、新话轮、run/目标修订、接管、身份不足或原迟到回执已解决 unknown 时保留原结果并给 skipped 原因。文档/保护属性在派发后变化时，扩展拒绝读取字段值，不能把已派发的读请求冒充成功观察。

内容仍经过既有 wrapPageContent/redactCredentialText；密码、一次性验证码及支付保护字段按既有规则排除。附属读取不新增敏感正文日志，不调用 confirm_blocked_write，不改变反馈渠道或持久化 schema。

## 修前反例与修后结果

修前使用真实宿主/RPC，丢弃模拟扩展的原 fill 回执并推进原 30 秒超时：只有「写前读取 → fill」，预期的附属 read_element 缺失，新增反例失败；原直连用例 19 项通过。见 checks/red.txt。

| 路径 | 修后机器检查结果 |
|---|---|
| 有完整原目标身份，读到期望值 / 空串 / 不匹配值 | 一次 fill、一次附属读取；均 observed，matchesExpected 分别 true / false / false；原 unknown 和写入限制保留 |
| 读取失败 / 1500ms 超时 | 原 fill 错误、宿主 ID、传输 ID 保留；readback.failed；无第二次读取，RPC pending 清除 |
| 新话轮、取消、接管、run 变化、身份/保护属性不足 | skipped，无错误目标读数或陈旧成功反馈 |
| 同 URL 换文档、读取期间换文档、字段变密码、截止时间过期 | 扩展不返回可用字段证据；换文档/保护字段的前置拒绝中，值访问次数为 0 |
| executed / not_executed fill；unknown click / press_key / type_text | 不增加附属核查 |
| 读取占用期间再请求直连操作 | 原占用未释放，第二操作被拒绝 |
| 原合法迟到回执在恢复之前 / 期间 / 之后到达 | 沿原 RPC/任务结果机制处理；读取本身不解除 unknown，真实原回执可以更新执行事实与原结果项 |
| 超长读数 | function_call_output 合法 JSON、总长度不超过 12000；保留原事实、读取状态/ID，明确 truncated |

matchesExpected 仅表示实际 value 与原 fill.value 字面相等，不是 Goal 判定；原有下拉框的可见标签与内部 value 区别也不能由这个布尔值代替。附属读取只形成一次当前状态观察。

## 一条贯穿调用与返回

下列 ID 和结果取自最终离线测试记录；provider ID 由模拟 provider 独立生成，display ID 与 RPC ID 由生产代码分别生成。写前普通读取是建立身份的已有调用，不计为附属恢复；它的实际 ID 保存在 readback.target.sourceToolCallId/sourceTransportId。最终只有两个 provider 输出（写前读取与原 fill），没有伪造第三个 provider read_element 调用。

```json
{
  "call_id": "call_f511f5b9-8ea3-4438-930c-353067befb58",
  "output": {
    "ok": false,
    "toolCallId": "display-260f589c-750b-4cea-b2ac-a5dc1191dd79",
    "transportId": "27e5900d-0e15-47e2-b38b-05eede3ca946",
    "executionFact": "unknown",
    "error": "Tool call \"fill\" timed out after 30000ms",
    "readback": {
      "toolCallId": "display-124981c5-f809-4090-a9c3-2074e86c7dde",
      "transportId": "c0bba98a-d1ee-45b7-a4b5-76707a29996f",
      "target": {
        "tabId": 7,
        "documentId": "doc-ced3f300-0295-4e21-bd0e-6b24593d93b2",
        "target": "@4",
        "sourceToolCallId": "display-7629ddb3-d475-44b5-8c34-bd9168bc35d7",
        "sourceTransportId": "fa45ab54-d6cc-4e9a-bd32-78aeaffe604d"
      },
      "status": "observed",
      "content": [
        {
          "type": "text",
          "text": "<page-content untrusted tab=7>\n{\"tabId\":7,\"target\":\"@4\",\"tagName\":\"input\",\"properties\":{\"value\":\"小明\"}}\n</page-content>"
        }
      ],
      "matchesExpected": true
    }
  }
}
```

同份证据的任务进度仍为 `successVerified=false`，fill 结果项 `status=unknown`；测试再请求 fill 被原写入限制拒绝。附属读取成功未触发额外成功反馈。原 fill 原本 reject 的路径仍 reject；如果核查期间收到合法原回执，回传可反映该新执行事实，但保持原异常语义，不把它归因于读回。

## 检查结果与并行工作

- PASS：相关范围共 15 个测试文件。首轮 194 项中 193 通过、1 个并行反馈断言失败；最终对受影响的直连、多轮、反馈对抗三文件重跑 49 项全通过，其余 12 文件的 145 项沿用已有通过结果，没有把重复运行累计成新样本。
- 首轮反馈失败来自立即检查异步音频放行；并行工作随后把该断言改成等待异步结果，本轮未修改 realtime-feedback-adversarial.test.ts。当前文件单独复跑通过；临时移除本轮结果/生命周期增量的隔离对照也通过当前测试。保留首轮失败日志，不冒称第一次全绿。
- PASS：`npm run typecheck`；`npm run check:architecture`（228 个生产文件）；`git diff --check`，并检查本轮未跟踪文件的独立 diff。
- FAIL（既有、范围外）：独立验收入口的全依赖类型检查仍有五处诊断：isolated-extension.mts 的 cdp.mjs/sw-hook.mjs 缺声明、runner.mts 的 cdp.mjs 缺声明，以及 runner.mts:56/81 的 Record 类型断言。工程 typecheck 不代表覆盖这个独立入口；未加忽略规则或改这些依赖。
- 依赖检查命令：`npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --allowImportingTsExtensions scripts/acceptance/realtime-fact-consumption.mts scripts/acceptance/realtime-fact-review.mts`。
- NOT_RUN：真实 Realtime/LLM、真实麦克风、真人体验、真实浏览器端到端、构建/重载、发布。不会据离线贯穿声称真实模型已按读数正确发言。
- 未 commit/push/reset/stash，未清理无关文件。并行 quietJudge、通知与反馈胶囊代码保留；连接层仅本轮两处结果封装修改计入下表。

## 本轮独立增删量

基线是本轮开始的文件副本，不把此前未提交或未跟踪文件算作本轮新增。连接层存在并行改动，额外按当前文件去掉本轮两处封装补丁重建对照，排除并行 quietJudge 增量。完整 scoped.diff、基线和统计保存在 checks/；out/ 生成证据不计代码量。

增长集中在宿主的一次恢复、既有 RPC 身份记录及扩展文档/截止时间门禁；测试覆盖跨边界反例。没有新增依赖、状态机、证据账本或页面解析器。已阅读实际差异；后续边界用“核查期间合法迟到回执”验证：原记录可恢复，读数不会改变原事实。

| 实际修改文件 | 新增 | 删除 |
|---|---:|---:|
| agent/src/session.ts | 72 | 3 |
| agent/src/realtime-voice-connection.ts | 8 | 2 |
| agent/src/realtime-browser-tools.ts | 14 | 0 |
| agent/src/rpc.ts | 76 | 5 |
| agent/src/tools.ts | 8 | 2 |
| shared/protocol.ts | 2 | 2 |
| extension/src/background/observation-document.ts | 6 | 2 |
| extension/src/background/exec/read-element.ts | 66 | 23 |
| extension/src/background/exec/input.ts | 21 | 4 |
| extension/src/background/index.ts | 6 | 1 |
| agent/test/realtime-direct-tools.test.ts | 219 | 0 |
| extension/test/read-element.test.ts | 66 | 0 |
| extension/test/explicit-page-target.test.ts | 16 | 0 |
| docs/evals/20260922-realtime-unknown-fill-readback.md | 129 | 0 |
| docs/STATUS.md | 1 | 1 |
| 合计（排除并行增量、out/ 证据） | 710 | 45 |

本轮到此停止，待独立 review；未授权加载日常产品。

## P1 同文档对象替换修复（本轮）

原第 2 条仅凭 documentId + target 不足以证明原对象；上文是第五切片首次实现记录，不代表本次 review 后结论。

### 本轮完成标准

- [x] CSS 同文档替换、DOM ref 重新分配以及替代值相同均拒绝/跳过，替代 value getter 零访问。— 谁检查：既有扩展参数化测试
- [x] 实际观察产生 AX 身份，经宿主、工具适配和扩展核对，原对象有效时仅一次受控读取；断开/身份缺失不生成 observed。— 谁检查：既有直连与扩展测试
- [x] unknown、reject、取消/接管、1500ms 与合法迟到回执语义保留；typecheck、architecture、diff 检查。— 谁检查：定点回归与实际命令

不扩大恢复范围，不进入第六切片，不追加模型、浏览器端到端、麦克风试跑，不提交或重载。

### 修前失败与修后结果

基线取本轮开始时的文件副本，保留此前与并行改动。先向既有 read-element 参数化测试加入 CSS/DOM ref × 不同值/相同值四项反例：修前 **4 失败、16 通过**；两种定位均成功读出替代 B 的值（含 OTHER_RECORD_VALUE）。见 [red.txt](../../out/acceptance/unknown-fill-p1-20260922/red.txt)。修后四项均拒绝，B 的 value getter 零访问。

- **可靠支持**：写前普通 read_element 真正经 AX 登记表分流到 DOM.resolveNode，读取成功后由扩展回执附带 `nodeIdentity={kind:ax,backendNodeId}`，与原 documentId、tabId、target 一起在 fill 派发前绑定。不是解析 `@数字` 推定来源，不接收模型提供的身份，不在超时后补原对象。
- **写入关联**：绑定的 AX fill 校验原 backendNodeId；若 ref 已变成 DOM ref，拒绝；debugger 不可用也不降级到同号 DOM ref。保留原异常语义，未重放填写。
- **读取关联**：缺身份时宿主直接 skipped（`original_node_identity_missing`）；扩展再次核对 AX 来源与节点号，再通过 CDP 原对象读取。原对象 isConnected 为 false 时，在 value 访问前拒绝；AX 转 DOM 或节点无法解析时不返回 observed。宿主检查读回回执的节点身份。
- **仍 skipped**：CSS/loc=css、无可核对代次的 DOM ref、缺字段元数据/文档身份、受保护字段，以及原有失效输入场景。C2 **snapshot-only 仍未覆盖**；本轮没有扩展 snapshot 元数据或新增节点缓存/注册中心。
- **贯穿正例**：改造既有 unknownFillFixture，不再手写读取成功回执。BrowserAgentSession → createBrowserTools → ToolRpc → 真实 readElement / axstate / 页面读取函数 → Realtime function_call_output；仅 provider、传输与 Chrome/CDP 为内存模拟，fill 仍模拟写入并丢弃回执。期望值、空值、不同值均只额外访问原 value 一次，原 unknown/reject/写锁保留。[贯穿记录](../../out/acceptance/unknown-fill-p1-20260922/through-path.json)。这不是浏览器端到端证明。
- **附加反例**：宿主贯穿 CSS、DOM 重绑、AX 节点脱离、AX 转 DOM，替代值恰好等于期望值仍 skipped，替代 getter 零访问。fill 边界另覆盖 DOM 重绑与 debugger 不可用拒绝降级。

### 本轮检查

| 检查 | 结果及证据 |
|---|---|
| 对象身份、read_element、显式目标、Realtime 直连 | 4 文件 75 项通过；[定点](../../out/acceptance/unknown-fill-p1-20260922/focused-final.txt)。跨工作区测试加载方式调整后，直连 48 项另复跑通过，[最终直连](../../out/acceptance/unknown-fill-p1-20260922/direct-final.txt)，不重复计数 |
| unknown、取消/接管、迟到回执、RPC、反馈与协议 | 9 文件 115 项通过；[回归](../../out/acceptance/unknown-fill-p1-20260922/regression.txt)。直连同时覆盖一次读取、1500ms 边界、原异常及无额外成功反馈 |
| npm run typecheck | PASS；[结果](../../out/acceptance/unknown-fill-p1-20260922/typecheck-final.txt) |
| npm run check:architecture / git diff --check | PASS；最终结果见 [静态检查](../../out/acceptance/unknown-fill-p1-20260922/static-final.txt) |
| 独立验收入口依赖类型 | FAIL，仍为原 5 处：isolated-extension.mts:12/13、product-journeys/runner.mts:18 缺 mjs 声明及 runner.mts:56/81 类型断言。未修改这些依赖；[当前诊断](../../out/acceptance/unknown-fill-p1-20260922/acceptance-types.txt) |
| 真实模型、浏览器端到端、麦克风、构建/重载 | NOT_RUN，按本轮边界未追加 |

中间失败没有计为通过：首次接入真实扩展后，3 个正例的测试误写普通读取会访问两次 value，实际默认只访问一次；改为写前清空计数、仅断言附属读取一次（focused.txt 保留）。首次类型检查暴露测试静态导入扩展导致 Node 工程拉入 Chrome globals；改为按模块 URL 加载扩展运行时并用共享 ToolContract 描述边界，扩展源码仍由原扩展 typecheck 完整检查；没有添加忽略规则或修改 tsconfig。

### 本轮独立增删量（P1）

以 `out/acceptance/unknown-fill-p1-20260922/baseline/` 的本轮入场副本计算，排除既有改动及 out 证据。完整 [scoped.diff](../../out/acceptance/unknown-fill-p1-20260922/scoped.diff) 可供独立 review。生产增量集中于携带 AX 来源、执行前拒绝错绑与读取前检查原节点连接性；测试增长用于把原手写读取回执换成真实扩展处理以及补替换反例。没有新依赖、长期缓存或状态管理框架。已阅读生产与测试差异，未修改 Goal 或反馈渠道。

| 文件 | 新增 | 删除 |
|---|---:|---:|
| agent/src/rpc.ts | 4 | 1 |
| agent/src/session.ts | 6 | 5 |
| agent/test/realtime-direct-tools.test.ts | 70 | 10 |
| docs/NOTES.md | 4 | 0 |
| docs/STATUS.md | 1 | 1 |
| docs/evals/20260922-realtime-unknown-fill-readback.md | 57 | 0 |
| extension/src/background/exec/input.ts | 7 | 3 |
| extension/src/background/exec/read-element.ts | 8 | 2 |
| extension/test/explicit-page-target.test.ts | 18 | 0 |
| extension/test/read-element.test.ts | 39 | 16 |
| shared/protocol.ts | 3 | 3 |
| 合计 | 217 | 41 |

本轮停止，交独立 review；不 commit/push/reset/stash/重载，不进入第六切片。

## 真实浏览器无模型验收

用户确认第五切片 P1 已通过独立 code review；本轮只检验真实 Chrome 路径，不修改生产能力。三个场景各一次，失败也保存证据，不以重跑取全绿。

完成标准（检查者：测试驱动及原始事件断言）：A 原 AX 对象有效，真实填写一次、丢弃真实成功回执，保留生产 30000ms 超时并自动读取一次；B 同文档替换成相同 CSS 定位且相同值的记录 B，value getter 零读取、无误报 observed；C 普通 snapshot-only 后 unknown 安全 skipped，但原 C2 仍未修复。所有场景保留 unknown/reject/写入限制，模型请求为零，独立页面探针不进入身份缓存。

运行输入使用含未提交修改的源码副本，在副本内构建；日常 dist 不构建、不重载。源码、构建和实际安装产物逐文件 SHA-256 关联。运行入口为 `scripts/acceptance/unknown-fill-chrome.mts`，复用 `isolated-extension` 的真实执行钩子及生产宿主工厂；provider 输入由测试生成，不启动 VoiceService、麦克风或模型连接。测试专用 manifest 去 key/nativeMessaging，并设置 connect-src self；宿主关闭 route shadow，模型推理入口及网络出口均有阻断与计数。

### 结果：整体尚未完成真实浏览器验收

| 场景（各一次） | 结果 | 实际证据 |
|---|---|---|
| A 原对象仍有效 | **BLOCKED** | Chrome 已启动，isolated-extension 的 executeToolCall 钩子等待 Debugger.paused 12 秒超时；未发出 snapshot/read_element/fill，没有有效正例。未重跑 |
| B 同文档替换 | **PASS** | 原 A 真实写入一次，真实成功回执在传输边界丢弃；30036ms 后宿主保持 reject/unknown，发出一次附属读取。扩展返回 READBACK_NODE_DETACHED，宿主 skipped/original_node_unverifiable；B 的值同为星河但 getter 计数为 0，原 A 脱离后的 getter 也为 0，写入限制保留 |
| C snapshot-only | **PASS（仅安全跳过）** | snapshot → fill，实际写入一次并丢弃成功回执；30010ms 后 reject/unknown，skipped/original_field_identity_missing；read_element 总调用数为 0，无重放，写入限制保留。**原 C2 尚未修复，功能覆盖仍未通过** |

[三例原始汇总](../../out/acceptance/unknown-fill-chrome-20260922/runs/summary.json)，[A 原始事件](../../out/acceptance/unknown-fill-chrome-20260922/runs/A/events.jsonl)、[B 原始事件](../../out/acceptance/unknown-fill-chrome-20260922/runs/B/events.jsonl)、[C 原始事件](../../out/acceptance/unknown-fill-chrome-20260922/runs/C/events.jsonl)。失败结果不删除，预算文件和每例 started.json 保留；没有重复试跑。

### 实际运行输入

- 源码副本包含本轮入场时的未提交/未跟踪实现及本轮验收脚本，共 781 个输入文件；复制前后及运行结束后逐文件一致。`HEAD=94b1782` 只是参考，不用于代表运行版本。完整 [源码清单](../../out/acceptance/unknown-fill-chrome-20260922/source-manifest.json) 的 SHA-256：`9de8df766b229d2572c6fba48e81f90d86afe214385e48dd59dc0adfa690e5a5`。
- 构建在 `out/acceptance/unknown-fill-chrome-20260922/source/` 内运行现有 extension/build.mjs；[构建日志](../../out/acceptance/unknown-fill-chrome-20260922/build.log)、[全部产物哈希](../../out/acceptance/unknown-fill-chrome-20260922/build-manifest.json)。background.js SHA-256：`3c736ddcf010b0f387450ee26e5a81f07375d7fc0b88d604b03c6047d3d8a675`。
- 每例加载独立临时扩展副本。除测试 manifest 的去 key/nativeMessaging 与 CSP 外，安装文件逐个等于固定构建产物；B/C 另在实际 service worker 内读自身 background.js 并计算相同 SHA-256。A 未完成钩子，安装目录由其唯一 DevToolsActivePort 记录恢复并核对文件，不能冒充 A 的执行链已通过。[A 安装目录恢复](../../out/acceptance/unknown-fill-chrome-20260922/A-profile-recovered.json)。
- Chrome for Testing **153.0.8010.52**，独立 `--headless=new` profile，无 fakeMedia、无账号、无麦克风；[二进制身份](../../out/acceptance/unknown-fill-chrome-20260922/chrome-binary.json)。B 扩展 ID 为 `cnjceipeljbhegemicpkoaafojpgjjkh`，C 为 `gbljckgipandeaikmmnppjggdingiehp`；各自 profile 路径和完整安装清单在 runtime-identity 事件。
- [最终完整性检查](../../out/acceptance/unknown-fill-chrome-20260922/source-integrity-final.json)确认当前生产源码仍等于固定副本、日常 extension/dist 全部哈希未变化。原八次实验文件未修改；未提交、推送或重载日常产品。

### 原对象与调用关联

B 原文档为 `014F6A3A9A6147DCEEF08CB828C23646`，实际 AX 树输出 `@2`，read_element 返回 `{kind:ax,backendNodeId:2}`。这两个值均由浏览器产生，不在脚本写死。替换前后独立 InjectionResult.documentId 相同；探针仅观察夹具，不补宿主身份。

| B 链路 | 宿主调用 ID | 传输 ID |
|---|---|---|
| 写前读取 | display-4f55e303-5e9e-48a5-88c1-e2432355d0b6 | 464bee40-9669-4215-ba83-5015840ba9eb |
| 原 fill | display-87c7a29c-74c0-4e71-b69f-aeed5943bcb9 | fb077a85-da56-4532-930c-6d5de66d260a |
| 附属读取 | display-9245e6ef-63d7-4033-9464-d64e7ef42697 | 64329d68-756e-42f1-8369-72cf777274a9 |

原 fill 测试/provider callId 为 `test-call-fe3520a5-0cf4-4853-bd5f-591bf2644bb5`；没有伪造附属 provider 调用。断言核对实际 ToolRpc.getTransportId、fillTarget.sourceToolCallId/sourceTransportId、扩展 tool_result.id 和附属 readback IDs 的映射，而非只比较字符串 target。B 原成功回执确实是 ok/executed，再由边界丢弃；生产 RPC 自己等满 30000ms 后产生 unknown。

C 原文档为 `FED3A4B02EED74A80303CBC468665C68`，AX 目标也由本例 snapshot 单独提取；原 fill 的宿主 ID 为 `display-43c6f163-b00f-4333-9519-3b0c2d4e0216`、传输 ID 为 `ee925ed7-09fb-4a3a-b139-43811fd23701`、测试/provider callId 为 `test-call-f92657eb-8401-413a-9be2-fb94673daca6`。宿主没有 fieldTarget 身份，不存在附属读取 ID。所有输入身份、映射、原始回执及页面探针汇入 [evidence-summary.json](../../out/acceptance/unknown-fill-chrome-20260922/evidence-summary.json)；该文件只提取原事件，不能替代原日志。

### 零模型与清理检查

- 三例实际推理调用计数均为 **0**，非验收网络尝试计数均为 **0**，转发模型请求为 **0**。每例先做一次阻断器自检，虚构模型 URL 在 fetch 包装层即被拒绝，未发送网络请求；自检与正式计数单列在事件中。
- `SIDEAGENT_ROUTE_SHADOW=0`，代码读取确认 routeShadowEnabled=false；独立空 SDK 凭据目录，关闭 catalog 网络刷新；现有本地 acceptance 模型只提供 SDK 会话模型目录项，stream/complete 等入口统一抛错计数，未调用模型。生产 createConversationRuntime、BrowserAgentSession、工具适配和 ToolRpc 均实际运行；没有模拟预设成功的 Chrome/CDP/扩展回执。
- 宿主 fetch 仅放行本次 CDP 的本地 /json/version，Socket 仅放行该端口；扩展启动前即撤销 nativeMessaging、限制 connect-src self，Chrome DNS 仅放行 localhost fixture。没有连接日常宿主/浏览器、真实账号或麦克风。
- 每例总预算 90 秒。B/C 断言与结果保存完成后，工作进程未自行退出，由 supervisor 到时终止自己的进程组；supervisor.json 如实保留 timedOut=true，**不是 fill/读回断言超时**。这是验收运行器收尾缺口，不计成生产故障。三组 PID/PGID **45763、46459、50162** 最终均不存在，[清理实查](../../out/acceptance/unknown-fill-chrome-20260922/cleanup-final.json)。临时 profile/构建文件保留作证据，没有清理无关文件。

### 未决问题与最小建议

1. **A 缺真实正例证据**：阻断位置是 sw-hook.mjs 的 installExecuteToolCallHook 等待 Debugger.paused；不是已证实的 P1 失败。相同固定输入下 B/C 的隔离启动成功，原因尚未确定，不能据此把 A 改判通过。建议仅在测试运行器补充 probe 页就绪、executeScript 完成和 SW 异常证据，再确定钩子就绪条件；本轮未修改生产代码，也未重新尝试 A。
2. **B/C 工作进程收尾**：已由有界 supervisor 清理。建议后续先定位并排空测试传输 delivery/CDP 队列及 SDK 活跃句柄，避免结束后等 supervisor 超时；本轮不猜测具体持有者、不借机修改产品生命周期。
3. 独立验收入口类型检查仍为原 **5 处**诊断：isolated-extension.mts:12/13、product-journeys/runner.mts:18 缺声明，以及 runner.mts:56/81 类型断言；新脚本没有新增诊断。没有添加忽略规则，[类型检查](../../out/acceptance/unknown-fill-chrome-20260922/types-final.txt)。git diff --check 与新增脚本独立空白检查通过；未扩大运行产品单测或真实模型。

humanAcceptance、真实模型语言验收均为 **NOT_RUN**。真实 Chrome 正例 A 尚缺，本轮不能宣称第五切片真实浏览器完整验收通过；C2 snapshot-only 仍未修复。完成本次有界尝试后停止，交独立 review。

### 本轮独立增删量（真实 Chrome 验收）

只统计本轮增量；STATUS 用当前文件去掉本轮第五切片段落重建对照，剔除并行 V2.1 状态更新，原入场副本仍保留。生产代码 **+0 / -0**，忽略的源码副本、构建、profile 和原始事件不计。完整 [本轮差异](../../out/acceptance/unknown-fill-chrome-20260922/scoped.diff)。增长集中在三个场景的本地 fixture、真实回执丢弃、零模型门禁、ID 断言和有界进程监督；复用原隔离执行器，没有新增依赖或框架。

| 文件 | 新增 | 删除 |
|---|---:|---:|
| scripts/acceptance/isolated-extension.mts | 7 | 1 |
| scripts/acceptance/unknown-fill-chrome.mts | 228 | 0 |
| docs/evals/20260922-realtime-unknown-fill-readback.md | 68 | 0 |
| docs/STATUS.md | 1 | 1 |
| docs/NOTES.md | 2 | 0 |
| 合计 | 306 | 2 |

## 运行器修复与 A 单次补验（2026-09-22）

本节是新增授权；以上 A/B/C 的结果、历史退出码及证据保持原样。仅修改验收运行器和离线反例，使用原固定生产源码及扩展产物；不构建、不加载日常、不重跑 B/C，不进入第六切片。humanAcceptance、真实模型语言验收保持 NOT_RUN。

### 完成标准（执行前）

- [x] 请求的场景全部 PASS、清理成功、工作进程正常退出时才允许整体 0；阻塞、失败、异常、清理超时和 supervisor 兜底均非零。场景、清理与进程结果分别记录。— 检查者：离线子进程反例及真实 supervisor
- [x] CDP 正常关闭/断开均终结请求和事件等待，清除计时器和监听器；关闭后拒绝新工作，重复关闭安全，无未处理拒绝。— 检查者：模拟 WebSocket 离线反例
- [x] 钩子按页面与脚本事件就绪，记录 probe、注入、消息、SW 异常及 session；触发失败可见，不等待被暂停 SW 上完整触发才处理暂停。— 检查者：模拟事件及一次真实 A
- [x] delivery 停收、排空或终止后关闭资源；部分初始化失败也给出真实清理结果。记录队列/句柄证据，旧 B/C 没有的证据不补写成确定原因。— 检查者：离线反例与本次资源快照
- [x] 只补验真实无头 A 一次，原 30000ms 超时、真实 AX/原对象、一次 fill/附属读取、unknown/reject/写限制与零模型要求不变；失败也留档并停止。— 检查者：运行事件、断言与进程退出

本次入场副本、离线与真实证据位于 `out/acceptance/unknown-fill-runner-repair-20260922/`；增删量以本次入场副本独立计算。

### 修前反例、修改与离线结果

- **退出状态**：原 A `status=BLOCKED`、`cleanup.host/browser=true`，实际没有取得 manager/iso，worker `code=0`；原主运行器未根据场景/清理/子进程设置退出码。新运行器分别保存场景、资源清理、工作进程与整体结果，显式 `--cases` 选择场景；只有所有请求场景 PASS、清理 PASS、子进程 code=0、无信号/兜底/残留进程组时整体才为 0。使用 `process.exitCode` 自然退出，没有 `process.exit(0)`。原 A/B/C 文件逐文件未变。
- **CDP 生命周期**：离线同时发请求和事件等待后 close，原版两个 Promise 均未结束、剩余 2 个计时器；修后两个均拒绝、计时器和 socket 监听器均为 0。[修前/后数值](../../out/acceptance/unknown-fill-runner-repair-20260922/cdp-counterexample.json)、[修前失败](../../out/acceptance/unknown-fill-runner-repair-20260922/cdp-red-corrected.txt)。同一客户端集中回收 request/ready/event 等待；正常关闭、意外断开、error、发送失败均结束对应操作，关闭后拒绝新增；close 超时会拒绝而非假装成功。session/predicate/AbortSignal 用于准确匹配和撤销钩子等待。
- **delivery 与部分创建**：停收 → dispose 宿主 → 有界排空 → 关闭 CDP/Chrome/fixture；排空失败时取消未开始项，关闭 CDP 终结在途等待，再收集结果。任何清理失败仍使整体非零。隔离资源从 fixture 创建前即受 try/finally 等价的 catch 清理保护；未创建项记 NOT_CREATED，不用可选调用假写 true。Chrome 正常收尾用 SIGTERM 并等待 close；SIGKILL 仅超时兜底且记 FAIL。
- **定点离线验证**：Node 内置 test，无新依赖或框架；17 项通过，包括连接关闭/断开、延迟 scriptParsed、页面 loading→complete、注入失败、错误 session 暂停、触发失败、先暂停后恢复才完成触发、队列超时取消、部分资源清理、场景失败/阻塞、worker 异常/缺结果/启动失败、清理失败和 supervisor 超时。命令：`node --import tsx --test scripts/acceptance/runner-lifecycle.test.mts`；[补验前最终输出](../../out/acceptance/unknown-fill-runner-repair-20260922/offline-before-A.txt)。
- 中间检查如实保留：首份 CDP 反例的 WebSocket mock 构造方式有误，改成直接替换测试类后两项仍因真实未回收而失败；首轮综合测试 6 个失败来自 JSON 丢弃 undefined 与内存对象的比较，改成显式 null 后通过。未放松场景断言或把中间失败记成通过。

### A 钩子结论与历史证据缺口

已确认旧代码把“等待 400ms”当作 probe 页可注入，`void` 异步触发未回传失败，scriptParsed 也在 150ms 后停止监听；暂停事件没有限定 SW session。原 A 日志只含最终 paused 超时，缺页面状态、注入结果、消息状态和 SW 异常，所以**无法确认旧 A 究竟由哪一项触发**，不能把固定 sleep 直接定为历史唯一根因。

现在先确认 tabs complete、实际注入 document/URL/readyState，再安装断点并只发一次触发；监听目标 session 和本次断点。触发失败与暂停并发等待，触发成功不代替 paused，先处理暂停再等完整触发返回。作用域查找沿同一消息经过的有限 listener 前进，没有重发消息或重试到成功。恢复前先移除断点，finally 关闭 Debugger 并移除 probe 页。

本次事件 5–14 记录：probe complete 且注入成功，消息 sent/delivered 均 true；4 次暂停均属于 `542D7C9CBA50468E1D6C2FC6411F1414`，最终进入 controller 作用域，钩子清理 PASS；观察区间没有 Runtime.exceptionThrown。[完整新事件](../../out/acceptance/unknown-fill-runner-repair-20260922/runs/A/events.jsonl)。这是本次就绪链的正证据，不补写旧日志。

### 唯一一次新 A：场景、清理、进程分别通过

| 项目 | 实际结果 |
|---|---|
| 场景 | **PASS**；真实 snapshot/AX → 成功 read_element 建立身份 → 一次 fill，丢弃真实 ok/executed 回执 → 原 30000ms 超时后一次附属读取；fill 到断言 30038ms |
| 原对象 | tab `2067548701`、document `94068678CE5FAEDA7573711DABDC9362`、AX backendNodeId `2`；附属 getter `aReads=1`，写事件仅 1 个；读取 observed、matchesExpected=true |
| 原事实与限制 | 原 fill 仍 reject/unknown；`successVerified=false`、写入限制仍在，没有重放/解锁 |
| 清理 | **PASS**；delivery DRAINED，宿主 CLOSED，CDP/Chrome/fixture 全部 CLOSED |
| 进程 | worker **0**，supervisor/整体 **0**；timedOut=false、groupTerminationSent=false、groupRemaining=false。全例事件跨度 35061ms，自然退出；PID/独立 profile 进程已不存在 |
| 模型 | modelCalls=0、blockedNetwork=0、forwardedModelRequests=0；阻断器自检另列，未发模型请求 |
| 预算 | 新目录仅 A 的一个 started/worker-started；B/C 没有重跑，旧三例不覆盖 |

[场景及清理结果](../../out/acceptance/unknown-fill-runner-repair-20260922/runs/A/result.json)、[进程结果](../../out/acceptance/unknown-fill-runner-repair-20260922/runs/A/supervisor.json)、[整体结果](../../out/acceptance/unknown-fill-runner-repair-20260922/runs/summary.json)、[完整性与提取证据](../../out/acceptance/unknown-fill-runner-repair-20260922/final-integrity-and-evidence.json)。原 fill 的 transport ID 为 `81377c70-9b0e-47c6-9cd5-a2aa624cb6ed`，附属读取为 `d99285d8-861f-4210-a423-637d7f1fd81b`；完整原身份来源与宿主 ID 映射在 result/binding 和原事件中。

### B/C 收尾归因边界

本次 A 收尾前明确观察到：delivery 在处理 `status`，队列另有 `conversation_updated`、`agent_event`、`task_view`；CDP 有 1 个 Runtime.evaluate 在途。排空后队列为空，CDP 请求/操作/监听器均为 0，随后自然退出。故“场景断言已结束”确实不等于“传输已完成”。关闭后的 async_hooks owners 是尚未收到 destroy 回调的分配记录，不能单独当成活跃计时器；同刻 active 列表已无 Timeout，最终进程自然退出提供终态证据。

旧 B/C 没有保存清理时的句柄、CDP pending 或 delivery 状态，且原进程已被终止，**其具体滞留持有者仍缺历史证据**。本次 A 的队列快照说明必须先排空，但不能据此反推旧 B/C 唯一根因。另用原固定源码进行无 Chrome、无工具输入的真实宿主创建/销毁探针，进程自然退出；[句柄分配记录](../../out/acceptance/unknown-fill-runner-repair-20260922/host-handles.json)仅排除“基本宿主初始化就必然滞留”，不排除执行后的 SDK 状态。原 B/C 局部 PASS、timedOut=true、code=143 保持历史原样。

### 实际版本、检查及并行保护

- 原生产输入清单仍为 `9de8df766b229d2572c6fba48e81f90d86afe214385e48dd59dc0adfa690e5a5`，781 项原始清单验证一致；复制原 source 和已构建 dist 到新证据目录，只覆盖 4 个运行器文件并附离线测试。**没有重新构建生产产物**。
- 实际安装和 SW 自读 background.js 均为 `3c736ddcf010b0f387450ee26e5a81f07375d7fc0b88d604b03c6047d3d8a675`；其余文件逐项与原 build-manifest 相等，仅既有测试 manifest 隔离变换保留。日常 dist 未变。
- 运行器/离线测试单独清单 [runner-inputs.json](../../out/acceptance/unknown-fill-runner-repair-20260922/runner-inputs.json)，SHA-256 `cfcab79e798ccfa787c926a39ca19af51f1c4372db255c1942d77b9e400f6bc0`。其中 4 个运行器与工作区最终代码逐字节一致，生产清单不混入修订后的运行器哈希。
- **浏览器差异**：本次未设置 EGO_ACCEPTANCE_CHROME，既有自动选择逻辑使用缓存 Chrome for Testing **149.0.7827.55**（profile/Last Version 一致）；旧三例是 **153.0.8010.52**。新二进制哈希 `b1b9e2dd063115031f08eadc10ed381ca0fa05b2284baff8f721d87f5f0f61b7`。[二进制及 profile 清理核对](../../out/acceptance/unknown-fill-runner-repair-20260922/chrome-and-cleanup.json)。本次按“原固定生产源码与扩展产物”执行，但不是同浏览器版本的因果对照；不追加试跑来消除该差异。
- 入口类型检查仍 FAIL，**恰为原 5 处诊断**：isolated-extension.mts:12/13、product-journeys/runner.mts:18 缺声明及 runner.mts:56/81 类型断言；新运行器未增加诊断，未添加忽略规则。[输出](../../out/acceptance/unknown-fill-runner-repair-20260922/types.txt)。检查命令沿用上文并加入 unknown-fill-chrome.mts。
- JS 语法、差异与空白检查通过。没有运行无关产品全量测试；没有 commit/push/reset/stash/重载。期间语音并行者修改的 realtime-voice-connection、quiet-hold/boundary 测试、STATUS 与 voice-feedback-v2 文档保留，不归入本轮增量。
- 本轮只追加原验收文档，不改 STATUS/NOTES，遵守用户限定的文件范围。humanAcceptance、真实模型语言仍 **NOT_RUN**；原 C2 snapshot-only 仍未修复。停止，交独立 review；不进入第六切片。

### 本轮独立增删量（运行器修复）

以 `out/acceptance/unknown-fill-runner-repair-20260922/baseline/` 入场副本为基线；排除原未提交内容、并行修改和 out 证据。实际 [scoped.diff](../../out/acceptance/unknown-fill-runner-repair-20260922/scoped.diff)、[统计](../../out/acceptance/unknown-fill-runner-repair-20260922/numstat.json)。生产代码 **+0/-0**。增长用于统一 CDP 等待的释放、独立退出/清理结果、可撤销钩子就绪以及反例；不新增依赖或测试框架。已阅读实际差异，场景业务断言与原 30000ms 未改；“触发失败时已有事件等待”和“关闭时已有排队工作”用于验证生命周期边界。

| 文件 | 新增 | 删除 |
|---|---:|---:|
| scripts/acceptance/cdp.mjs | 103 | 70 |
| scripts/acceptance/isolated-extension.mts | 86 | 36 |
| scripts/acceptance/sw-hook.mjs | 123 | 114 |
| scripts/acceptance/unknown-fill-chrome.mts | 111 | 36 |
| scripts/acceptance/runner-lifecycle.test.mts | 179 | 0 |
| docs/evals/20260922-realtime-unknown-fill-readback.md | 74 | 0 |
| 合计 | 676 | 256 |
