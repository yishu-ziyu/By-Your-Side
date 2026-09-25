# 任务: 只装扩展（不连本机伴随进程），阶跃主力下日常请求与语音都能用

2026-09-25，基线 `93a37b9`。用户先同意把当前构建加载进日常 Chrome、走一遍「只装扩展」，并授权代理从本机套餐文件填 key；随后要求：搭端到端测试证明阶跃可用，查清如何模拟麦克风、为什么用户的使用记录无法分析，并对未确认点逐个追根因、给解决方案。

## 完成标准

- [x] 1. 日常 Chrome 里扩展改走扩展内 agent，没有拉起本机伴随进程。— 谁检查：`chrome.runtime.getContexts` 出现 `OFFSCREEN_DOCUMENT inproc.html`；运行前后 `pgrep` 找不到 `agent/src/main`。
- [x] 2. 日常设置页配好模型：智谱 `glm-5.3-flash` 测试连接 1.3 秒、阶跃 `step-3.7-flash` 4.4 秒，都保存成功。— 谁检查：设置页状态文字、`chrome.storage.local` 键名（不读密钥）。
- [x] 3. 设置页换模型后，新对话用新模型。— 谁检查：`extension/test/inproc-config.test.ts`（修复前失败：调用的是 `vendor-a/model-a`）；阶跃端到端每条都断言模型请求发往 `api.stepfun.com`。
- [x] 4. 首次使用时先打开侧栏、后配模型，新建会话仍能完成。— 谁检查：`inproc-config.test.ts` 第二条（修复前超时）；隔离端到端在修复前卡在第 2 条「新会话」，修复后 10 条连续新建都通过。
- [x] 5. 阶跃主力、只装扩展，日常 10 条 10/10。— 谁检查：`everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash`，[产物](../../out/acceptance/real-path/2026-09-24T19-08-21-568Z-everyday-baseline-inproc/summary.json)。
- [x] 6. 阶跃语音（文件麦克风、真实 StepFun Realtime）：问页面内容、语音圈画、终止任务都通过。— 谁检查：`inproc-voice.mts --case=question|mark|stop-task --model=stepfun/step-3.7-flash`。
- [x] 9. 只装扩展时留下诊断记录（用户 2026-09-25 选「照本机模式记录」）：行格式与本机相同，设置页能导出、能清空，导出不含 API key。— 谁检查：`everyday-baseline.mts --inproc` 的 `traceCheck`，[产物](../../out/acceptance/real-path/2026-09-24T19-45-41-997Z-everyday-baseline-inproc/summary.json)：10 个会话、360 行，清空后导出为空。
- [x] 10. ref 属于另一个标签页时，动作说明来源标签页、记为未执行，不误报「已失效」，也不锁住后续写入。— 谁检查：`extension/test/click-robustness.test.ts` 新增两条（修复前都失败）；修复后阶跃 10/10。
- [x] 11. 语音记录在扩展里落地：与本机日常模式同一套行（`shared/voice-capture-core.ts`），写进同一个 IndexedDB，设置页导出为单独的 jsonl；不存录音（本机也只在诊断模式存）。— 谁检查：`inproc-voice.mts` 新增 `voiceRecordExported`：导出文件有 asr、text 行，与侧栏听到的句子一致、不含语音密钥；[产物](../../out/acceptance/real-path/2026-09-24T19-59-49-391Z-inproc-voice-question/result.json)。第一次按「必须有 ready/append/commit」判失败，查明这三类只在诊断模式产生、本机 09-20 以来的日常记录也没有，属于判据写错，已改。
- [x] 12. 复制任务提速（D）且核对不放松：阶跃只装扩展，复制 3/3 通过，中位 26.4 秒（改前 65.9 秒）；完整 10 条 10/10。— 谁检查：`agent/test/task-goal-tool.test.ts` 新增 3 条（改前都失败）+ `everyday-baseline.mts --inproc`，[产物](../../out/acceptance/real-path/2026-09-24T20-12-33-259Z-everyday-baseline-inproc/summary.json)。
- [x] 13. 圈「名称 + 数值」时一个框圈住两者，名牌不压页面文字（E，用户 2026-09-25 在预览里选「A + 避让兜底」）。— 谁检查：`everyday-baseline.mts --inproc --only=mark` 的新判据（CDP 读框和名牌位置，对照页面每个文字节点）：改前 FAIL，改后 3/3，[产物](../../out/acceptance/real-path/2026-09-25T02-19-27-080Z-everyday-baseline-inproc/summary.json)；`extension/test/overlay-check.mjs` 新增 through 用例：量手绘框线本身，名称变长后框线跟着重画（关掉重画则 FAIL）。
- [x] 14. 点完麦克风马上开口，说的话不丢（B）：会话就绪前的人声也送到服务端。— 谁检查：`inproc-voice.mts --case=question --lead=300` 的新判据 `speechDelivered`（WAV 人声时长对比实际发出的人声时长，不依赖服务端断句）：改前 2/2 为 0 ms（[产物](../../out/acceptance/real-path/2026-09-25T03-34-24-919Z-inproc-voice-question/result.json)），改后 5/5 为 2300/2180 ms，其中 4 次整句听全并答对（[产物](../../out/acceptance/real-path/2026-09-25T03-48-57-169Z-inproc-voice-question/result.json)）。
- [ ] 7. 两项修复进入日常 Chrome。— 谁检查：用户重载扩展后跑 `everyday-baseline.mts --daily`。
- [ ] 8. 真人语音试用和观感判断。— 谁检查：人。

## 结果

### 端到端数据（阶跃，只装扩展）

| 条目 | 结束（秒） | 模型请求数 | 首字节（秒） |
|---|---|---|---|
| 你好 / 1+1 / 好烦 | 4.3 / 3.8 / 5.0 | 1 / 1 / 1 | 2.9 / 3.1 / 2.4 |
| 核心观点 / 岗位城市 / 三个仓库 | 5.3 / 3.5 / 4.8 | 1 / 1 / 1 | 2.3–3.9 |
| 翻译 / 圈画 / 新标签页 | 16.8 / 6.0 / 6.9 | 3 / 2 / 2 | 0.8–2.7 |
| 复制不保存 | 118.9 | 22 | 0.6–2.8 |

同一套 10 条在日常 Chrome 里用智谱跑（修复前，[产物](../../out/acceptance/real-path/2026-09-24T18-09-58-469Z-everyday-baseline-daily/summary.json)）也是 10/10，但更慢：问答类 4.8–10.7 秒，复制 156.7 秒。

语音：问页面内容 17 秒两次通过（整句听全，答出「周五前发货」）；[语音圈画](../../out/acceptance/real-path/2026-09-24T19-19-50-144Z-inproc-voice-mark/result.json) 21 秒通过（圈住保存、未点击）；终止任务通过（回执前不宣称已停、点选层清除、迟到旧要求被拒）。

### 修掉的两个产品缺陷

1. **换模型只对已有对话生效**。offscreen 核心在第一次收到配置时启动，把当时的模型记成新对话的默认值；之后设置页再保存，只会给已有对话发 `set_model`。设置页却提示「侧栏接下来的任务会使用 阶跃星辰」。修法：新对话建立时按当前设置取模型，恢复的对话沿用自己记下的模型。
2. **首次使用时新建会话永远卡住**。侧栏一打开就发 `conversation_create`；这时还没配模型，`sendUnavailable` 不认识这条消息，回了一个没有会话编号的错误，侧栏一直显示「正在新建会话」。侧栏自己的超时退回在已有会话时直接跳过，救不回来。修法：未配置时把新建会话记下，核心启动后补处理。日常 Chrome 没碰上，是因为重载时已经有配置。

### 用导出的诊断记录复盘（A 的第一次实际用途）

阶跃 9/10 那轮（[产物](../../out/acceptance/real-path/2026-09-24T19-29-41-310Z-everyday-baseline-inproc/summary.json)）复制任务失败。用设置页导出的 jsonl 逐轮还原：T1 snapshot 带 tabId=241729442 读到 Note 页，草稿框是 `@1572`；T7、T9 fill 不带 tabId，报「已失效」；T13 click 同样失败，却被登记成结果未知；T15 fill 因「存在尚未确认结果的操作」被暂停；T16 部分完成。`run_start.context` 显示任务开始时的当前页是上一条开的 `/job`（241729447）。根因见 F。

### 失败与修正记录

- 隔离端到端第一次跑阶跃、跑智谱、撤掉修复再跑，都在第 2 条「新会话」超时：用来确认缺陷 2 是原本就有的，不是修复 1 引入的。
- 修复 2 之后，第一次语音问答 120 秒没进入语音状态，之后 2/2 通过。推断：测试写入配置后立刻点语音，正好撞上补处理的新会话切换。已给语音用例加上「启动时的新会话建好」再点击的等待。没复现出失败现场，所以这是推断。
- 语音圈画第一次失败在测试框架的 `Target.getTargets` 超时，产品动作没开始（和 [4e 的第 1 条](20260924-core-into-extension.md) 同类）；重跑通过。
- 撤掉修复的对照轮里，语音只听到「写的是什么？」，前半句丢了；另一次调试里，「已连接」到「正在听你说」之间隔了 8 秒。有修复的 3 次都听全了。丢字和 8 秒间隔原因未查（见根因表 B）。

- E 的第一版 overlay 判据量的是标注外层盒子，名称变长后盒子变宽就判通过；截图里手绘框线其实还停在原来的宽度（单元素标注本来也这样）。改为量框线本身，并在尺寸变化时重画框线、重摆名牌。
- E 的名牌放置单测是在函数写完后补的，没有先红后绿；红→绿证据以端到端判据和 overlay 判据为准。

- B 的推断被推翻三次：1）「前半句被切进 turn 1」——turn 1 只是就绪时的初值；2）「整句一次性灌给服务端导致断句失灵」——改成 4 倍实时匀速补发后失败率没变，失败的几次就绪反而早于开口、根本没补发；3）「服务端要先收到一段静音」——就绪后先补 3 秒静音，6 次仍 3 次失败。给 WAV 加底噪（`say` 的静音是绝对 0）也没用（5 次 2 次通过）。
- 对照（同一时段、不经缓冲）：就绪后 3 秒以上开口 8/8 通过（02:32–02:36），之后服务端 `speech_started` 比人声晚 7–10 秒、默认条件 4/5；就绪后 1 秒内开口 15 次 6 次通过。失败形态一致：服务端收到数千帧音频却不回任何事件，约 60 秒后断开重连。判断是 StepFun 侧的延迟与不稳定，不是本次改动；所以 `heardQuestion` 之外另加 `speechDelivered` 判音频是否送达。
- 逗号切句追查（用户 2026-09-25 同意按建议调静音时长）：建议被实验推翻。`say` 合成句「帮我把保存按钮圈出来，不要点它」逗号处停 340ms；`silence_duration_ms` 取 300/600/800 各 3 次，服务端 `session.updated` 回显新值，9/9 仍切成两轮，所以不改参数。带回复与工具事件的时间线（4 次，[产物](../../out/acceptance/real-path/2026-09-25T04-16-42-748Z-inproc-voice-mark/result.json)）显示后果：服务端在逗号处就创建回复，先说「我需要……」并调 snapshot，这时前半句转写未到，宿主按规则拒绝（「尚无本轮真实用户要求」）；后半句再触发一轮，read_elements 成功后模型说「现在用 mark 工具把它圈出来」却不调用就结束，3/4 没圈上（参数实验里 3/9）。未修，待定方向。
- 语音回归：终止任务改前、改后各跑一次，改前报「未收到实际播放完成确认」（改后通过），属原有不稳定；语音圈画改前、改后都被服务端在逗号处切成两轮，侧栏只显示「不要点它」，圈画本身正确。

## 根因与方案

| # | 现象 | 出在产品哪一块 | 依赖什么 | 方案 | 状态 |
|---|---|---|---|---|---|
| A | 纯扩展下的使用记录无法分析 | `extension/src/inproc/shims/run-trace.ts` 曾把 RunTrace 换成空实现 | 迁移第一版为去掉 Node 文件系统而关掉诊断 | 行格式与限额抽到 `shared/run-trace-core.ts`，本机写文件、扩展写 IndexedDB（`extension/src/shared/trace-store.ts`）；设置页「诊断记录」导出、清空。语音记录尚未搬 | 任务记录已完成并验证；语音未做 |
| B | 语音开口前几秒可能丢字（隔离环境 1/4 复现：「这个页面上的备注写的是什么」只识别出「的是什么？」） | 侧栏 `voice-client.ts` 的 `onCaptureFrame`：会话就绪前的麦克风帧直接丢弃。测试垫了 6 秒静音，就绪通常在开麦后 2.5–3.5 秒，所以一般看不出来；就绪慢于 6 秒时（今天实测 4.7–8.1 秒出现过 6 次）问句前半段被丢。真人点完就说，开口 2–3 秒必丢：`--lead=300` 时改前整句 0 ms 送达、什么都没听到。「turn 1 没有识别结果」不是线索：日常记录的 turn 从 1 开始，服务端检测到说话才进 2，通过的 6 次也都在 turn 2 | 会话建立耗时（StepFun `session.created`/`updated` 1.3–8 秒） | 就绪前的帧先留下（最多 15 秒），普通会话就绪后按 4 倍实时补发，补完前新帧排在后面；诊断会话不留 | 已修。另有供应商问题未修，见下方「失败与修正记录」：StepFun 断句延迟 2–10 秒、就绪后很快开口时约四成不回断句事件、逗号处切成两轮 |
| C | 「你好」在日常完整轮里 25.8 秒（冒烟轮 6.6 秒） | 未知：当时扩展里没有记录，无法区分模型首字节、核心启动还是排队 | 智谱供应商延迟、offscreen 冷启动 | 已让 `--daily` 挂上观察器；下次日常跑会记下这条的请求时间。隔离环境里阶跃 4.3 秒、智谱 5.1–6.0 秒，都没复现 | 等日常复测 |
| D | 复制不保存 45–160 秒 | 目标工具契约。阶跃的导出记录显示：verify 只认单个 `goalId`，schema 却允许传 `goals` 数组，模型连续 4 次传数组被拒，错误只说「先登记完整目标」；capture 要片段编号，inspect 却只给片段数量，模型猜文字偏移、把原文当编号，错误只说「来源片段范围无效」 | 模型每轮首字节约 1.5–3 秒 × 轮数 | 只给一个目标的 `goals` 数组按该目标核验，多个或编号错时列出可用 goalId；inspect 对小观察（≤24 个片段、≤2000 字）直接附片段编号与原文；片段编号错时列出可用编号和开头原文。原文复核与写入后精确比对不变 | 已修。对照（两组都带工作区里他人的 prompt.ts 改动，只切换本修复）：改前 91.7/65.9/49.1 秒、18/13/12 次调用；改后 25.5/40.6/26.4 秒、8/10/8 次；干净路径为 inspect→plan→capture→fill→verify→回复 |
| E | 圈画标签盖住旁边的「32%」 | 1）mark 只收一个 ref，快照里名称和数值是两个 text ref、没有整行 ref。阶跃的思考写着「只圈标签没有意义，我会圈出包含这两项的区域」，却只能传 `@1336`；工具说明要求圈数值，两个模型都没照做。2）`sketchLabelPosition` 固定放框外右侧，只看视口宽度 | 模型选哪个 ref；系统提示词里 mark 的示例只有 `{target,label}` | mark 加 `through`（同一行的结束 ref），页面里用 Range 从起点圈到终点，内容重排时重画框线；名牌依次试右、上、下、左，用 `elementsFromPoint` 检查底下的文字、图片、控件，都压字时沿上沿、下沿往右找空白；系统提示词和工具说明加上成对内容的用法 | 已修。只改工具说明时模型 3 次都没用 `through`；提示词示例补上后 3/3 使用、判据通过 |
| F | 复制不保存偶发失败（阶跃 9/10 那轮）：填写一直报「ref @1572 已失效」，最后以部分完成收场 | 1）上一条新开的 `/job` 成了当前页，fill 没带 tabId 落到它上面，AX ref 登记表按标签页分，找不到就报「已失效」，模型重新 snapshot 拿到的还是 @1572，陷入循环；2）click 定位阶段的失败走 domops 分支时没标「未执行」，被记成「结果未知」，后续写入全被暂停 | 测试框架没把工作页切回前台；产品的 ref 按标签页登记 | `axBackendNodeFor`：ref 来自别的标签页时直接说明来源 tabId、记为未执行；`resolvePointerTarget` 的任何失败都标未执行（此时还没发输入）；测试框架每条导航后 `bringToFront` | 已修，失败测试先红后绿，阶跃 10/10 |

## 模拟麦克风怎么做

隔离 Chrome 启动时加 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop`，在 macOS 上还要加 `--disable-features=AudioServiceSandbox`，否则会读成静音（见 `harness.mts` 的 `launchRealPath({ microphoneWav })`）。WAV 由 macOS `say` 合成，只放一遍。这些是 Chrome 启动参数，所以只能用在测试自己启动的 Chrome 上，日常 Chrome 不重启就加不上。日常 Chrome 里的真实语音，只能靠方案 A 的语音记录来复盘。

## 环境改动（需要恢复时照做）

- `~/Library/Application Support/Google/ChromeMain/NativeMessagingHosts/com.sideagent.host.json` 改名为 `….disabled-purext-20260925`。恢复：去掉后缀，重载扩展。
- 日常扩展存储新写入 `inproc_model_config`（阶跃）、`inproc_cred:stepfun`、`inproc_cred:zai-coding-cn`。
- 走查前的 `extension/dist` 备份在 `/tmp/bys-dist-backup-20260925`；它和 `93a37b9` 构建出来的结果完全相同。

## 边界与未跑

- 4g 备用模型的真实故障切换没有触发。
- 未跑全量测试；只跑了入口契约、`inproc-config` 测试、扩展类型检查、lint、上述端到端。
