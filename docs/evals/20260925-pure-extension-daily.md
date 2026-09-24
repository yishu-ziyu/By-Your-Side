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

## 根因与方案

| # | 现象 | 出在产品哪一块 | 依赖什么 | 方案 | 状态 |
|---|---|---|---|---|---|
| A | 纯扩展下的使用记录无法分析 | `extension/src/inproc/shims/run-trace.ts` 曾把 RunTrace 换成空实现 | 迁移第一版为去掉 Node 文件系统而关掉诊断 | 行格式与限额抽到 `shared/run-trace-core.ts`，本机写文件、扩展写 IndexedDB（`extension/src/shared/trace-store.ts`）；设置页「诊断记录」导出、清空。语音记录尚未搬 | 任务记录已完成并验证；语音未做 |
| B | 语音开口前几秒可能丢字（隔离环境 1/4 复现：「这个页面上的备注写的是什么」只识别出「的是什么？」） | 扩展语音会话的轮次切分：导出的语音记录显示这句落在 turn 2，turn 1 没有任何识别结果，推断前半句被切进第一个轮次后丢了 | StepFun Realtime 的断句与会话建立顺序；文件麦克风只放一遍 | 下一步在诊断模式下复现，拿逐帧 append/commit 时间线确认第一个轮次的音频去向；确认后再定是合并轮次还是缓冲首段音频 | 有线索，未修（[记录](../../out/acceptance/real-path/2026-09-24T19-58-53-888Z-inproc-voice-question/result.json)） |
| C | 「你好」在日常完整轮里 25.8 秒（冒烟轮 6.6 秒） | 未知：当时扩展里没有记录，无法区分模型首字节、核心启动还是排队 | 智谱供应商延迟、offscreen 冷启动 | 已让 `--daily` 挂上观察器；下次日常跑会记下这条的请求时间。隔离环境里阶跃 4.3 秒、智谱 5.1–6.0 秒，都没复现 | 等日常复测 |
| D | 复制不保存 100–160 秒 | 任务目标协议（`task_goals`）固定 7 轮，外加参数契约容易调错造成的重试；阶跃这次发了 22 次模型请求，单次首字节只有 0.6–2.8 秒 | 模型每轮首字节约 1.5–4 秒 × 轮数 | 按[已有调查](20260924-copy-task-latency.md)的前三项：宿主补 plan 的 id、错误信息写清是哪个字段；field verify 默认用刚才 fill 的 target；把观察编号直接放进首条提示。预计从约 7 轮降到 4 轮 | 方案已定，未实施 |
| E | 圈画标签盖住旁边的「32%」 | `extension/src/content/cursor.ts` 的名牌放置（`sketchLabelPosition`）：固定放框外右侧，只检查视口宽度，不检查右边有没有内容 | 模型选中的元素（这次选了「五小时用量」小元素，而不是整行） | 放名牌前用 `document.elementsFromPoint` 检测候选位置下有没有文字，按右、上、下、左依次选第一个不压字的位置；「标签 + 数值」这类成对内容，框取两者共同的行 | 待用户看过再改（影响页面观感） |
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
