# 任务: 只装扩展（不连本机伴随进程），阶跃主力下日常请求与语音都能用

2026-09-25，基线 `93a37b9`。用户先同意把当前构建加载进日常 Chrome、走一遍「只装扩展」，并授权代理从本机套餐文件填 key；随后要求：搭端到端测试证明阶跃可用，查清如何模拟麦克风、为什么用户的使用记录无法分析，并对未确认点逐个追根因、给解决方案。

## 完成标准

- [x] 1. 日常 Chrome 里扩展改走扩展内 agent，没有拉起本机伴随进程。— 谁检查：`chrome.runtime.getContexts` 出现 `OFFSCREEN_DOCUMENT inproc.html`；运行前后 `pgrep` 找不到 `agent/src/main`。
- [x] 2. 日常设置页配好模型：智谱 `glm-5.3-flash` 测试连接 1.3 秒、阶跃 `step-3.7-flash` 4.4 秒，都保存成功。— 谁检查：设置页状态文字、`chrome.storage.local` 键名（不读密钥）。
- [x] 3. 设置页换模型后，新对话用新模型。— 谁检查：`extension/test/inproc-config.test.ts`（修复前失败：调用的是 `vendor-a/model-a`）；阶跃端到端每条都断言模型请求发往 `api.stepfun.com`。
- [x] 4. 首次使用时先打开侧栏、后配模型，新建会话仍能完成。— 谁检查：`inproc-config.test.ts` 第二条（修复前超时）；隔离端到端在修复前卡在第 2 条「新会话」，修复后 10 条连续新建都通过。
- [x] 5. 阶跃主力、只装扩展，日常 10 条 10/10。— 谁检查：`everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash`，[产物](../../out/acceptance/real-path/2026-09-24T19-08-21-568Z-everyday-baseline-inproc/summary.json)。
- [x] 6. 阶跃语音（文件麦克风、真实 StepFun Realtime）：问页面内容、语音圈画、终止任务都通过。— 谁检查：`inproc-voice.mts --case=question|mark|stop-task --model=stepfun/step-3.7-flash`。
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

### 失败与修正记录

- 隔离端到端第一次跑阶跃、跑智谱、撤掉修复再跑，都在第 2 条「新会话」超时：用来确认缺陷 2 是原本就有的，不是修复 1 引入的。
- 修复 2 之后，第一次语音问答 120 秒没进入语音状态，之后 2/2 通过。推断：测试写入配置后立刻点语音，正好撞上补处理的新会话切换。已给语音用例加上「启动时的新会话建好」再点击的等待。没复现出失败现场，所以这是推断。
- 语音圈画第一次失败在测试框架的 `Target.getTargets` 超时，产品动作没开始（和 [4e 的第 1 条](20260924-core-into-extension.md) 同类）；重跑通过。
- 撤掉修复的对照轮里，语音只听到「写的是什么？」，前半句丢了；另一次调试里，「已连接」到「正在听你说」之间隔了 8 秒。有修复的 3 次都听全了。丢字和 8 秒间隔原因未查（见根因表 B）。

## 根因与方案

| # | 现象 | 出在产品哪一块 | 依赖什么 | 方案 | 状态 |
|---|---|---|---|---|---|
| A | 纯扩展下的使用记录无法分析 | `extension/src/inproc/shims/run-trace.ts` 把 RunTrace 换成空实现，扩展里不写逐轮记录；语音记录（`voice-capture-store`）也只在本机伴随进程里 | 迁移第一版为去掉 Node 文件系统而关掉诊断（见[工作流](../work/20260924-core-into-extension.md)「已定的决定」） | 扩展版 RunTrace：同样的 jsonl 行、同样的脱敏（`trace-sanitize.ts` 已可在浏览器用），写进扩展的 IndexedDB，保留天数和本机一致，设置页提供导出和清空；语音记录同理。这样用户日常使用留下的记录可以导出来，按 [复制耗时调查](20260924-copy-task-latency.md) 的方法逐轮分析 | 待用户决定（记录里有页面文字，属于隐私取舍） |
| B | 语音开口前几秒可能丢字 | 扩展语音会话：Realtime 已连接到开始收听之间有一段空档，这段时间麦克风的声音不进识别 | StepFun Realtime 的会话建立顺序；测试用的文件麦克风只放一遍 | 先用 A 的语音记录或 `stop-task` 那样的原始帧时间线，量清空档里发生了什么；如果是会话配置没下发完，就先把麦克风音频缓冲起来，就绪后补发 | 未查 |
| C | 「你好」在日常完整轮里 25.8 秒（冒烟轮 6.6 秒） | 未知：当时扩展里没有记录，无法区分模型首字节、核心启动还是排队 | 智谱供应商延迟、offscreen 冷启动 | 已让 `--daily` 挂上观察器；下次日常跑会记下这条的请求时间。隔离环境里阶跃 4.3 秒、智谱 5.1–6.0 秒，都没复现 | 等日常复测 |
| D | 复制不保存 100–160 秒 | 任务目标协议（`task_goals`）固定 7 轮，外加参数契约容易调错造成的重试；阶跃这次发了 22 次模型请求，单次首字节只有 0.6–2.8 秒 | 模型每轮首字节约 1.5–4 秒 × 轮数 | 按[已有调查](20260924-copy-task-latency.md)的前三项：宿主补 plan 的 id、错误信息写清是哪个字段；field verify 默认用刚才 fill 的 target；把观察编号直接放进首条提示。预计从约 7 轮降到 4 轮 | 方案已定，未实施 |
| E | 圈画标签盖住旁边的「32%」 | `extension/src/content/cursor.ts` 的名牌放置（`sketchLabelPosition`）：固定放框外右侧，只检查视口宽度，不检查右边有没有内容 | 模型选中的元素（这次选了「五小时用量」小元素，而不是整行） | 放名牌前用 `document.elementsFromPoint` 检测候选位置下有没有文字，按右、上、下、左依次选第一个不压字的位置；「标签 + 数值」这类成对内容，框取两者共同的行 | 待用户看过再改（影响页面观感） |

## 模拟麦克风怎么做

隔离 Chrome 启动时加 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop`，在 macOS 上还要加 `--disable-features=AudioServiceSandbox`，否则会读成静音（见 `harness.mts` 的 `launchRealPath({ microphoneWav })`）。WAV 由 macOS `say` 合成，只放一遍。这些是 Chrome 启动参数，所以只能用在测试自己启动的 Chrome 上，日常 Chrome 不重启就加不上。日常 Chrome 里的真实语音，只能靠方案 A 的语音记录来复盘。

## 环境改动（需要恢复时照做）

- `~/Library/Application Support/Google/ChromeMain/NativeMessagingHosts/com.sideagent.host.json` 改名为 `….disabled-purext-20260925`。恢复：去掉后缀，重载扩展。
- 日常扩展存储新写入 `inproc_model_config`（阶跃）、`inproc_cred:stepfun`、`inproc_cred:zai-coding-cn`。
- 走查前的 `extension/dist` 备份在 `/tmp/bys-dist-backup-20260925`；它和 `93a37b9` 构建出来的结果完全相同。

## 边界与未跑

- 4g 备用模型的真实故障切换没有触发。
- 未跑全量测试；只跑了入口契约、`inproc-config` 测试、扩展类型检查、lint、上述端到端。
