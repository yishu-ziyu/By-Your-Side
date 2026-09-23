# 任务: 查明端到端测试能否走「真侧栏 + 真伴随进程 + 真模型/语音」，且不碰日常数据

## 背景与裁决

- 用户原则：测试只判结果，按真实用户会走的路径写。
- 2026-09-23 用户裁决：任务模型和语音（StepFun）接真服务，不做替身。Jev 同为模型服务，本轮按同一裁决理解为真服务（待用户确认）；练习网站仍用本机页面。
- 本轮只跑小实验，回答方案里 5 个会改变做法的未知项，不改产品代码。

## 完成标准

- [x] 1. 无窗口 Chrome for Testing 按隔离浏览器目录里的清单拉起本地程序，且该程序继承 Chrome 的环境变量 — 谁检查: 脚本 p1（本地程序日志里有启动记录、扩展发来的 `hello`、标记变量相符）
- [x] 2. 查明 HOME 指到临时目录时，产品还能找到哪些模型和凭据；实验期间日常目录无变化 — 谁检查: 脚本 p2（`getAvailable()` 计数、凭据文件是否存在、前后目录快照）
- [x] 3. 无窗口下能否打开真侧栏；真侧栏与标签页里的面板看到的「当前标签页」是否一致 — 谁检查: 脚本 p1 的 p3 段
- [x] 4. 假音频设备能否把已知 WAV 送进扩展页的 `getUserMedia`（与产品同样的收音参数） — 谁检查: 脚本 p4（主频 660±3 Hz；RMS 与理论值比对；默认假设备作对照）
- [x] 5. 调试会话、Native 连接是否让扩展后台不被回收 — 谁检查: 脚本 p5 与 p1 的 p5c 段（扩展后台在场时间线）
- [x] 6. 由 Chrome for Testing 拉起的本地程序能否运行并读取桌面下的仓库代码 — 谁检查: 脚本 p1b

## 边界与不做

- 不改产品代码，不构建，不重载日常扩展，不 commit。
- 不读取、不打印任何密钥；凭据只查「文件在不在、权限是否私有」，子进程报错行做了长串脱敏。
- 不启动真实 `agent/src/main.ts` 的隔离实例：数据隔离还没做，启动就会写日常 `~/.sideagent`。
- 脚本和原始结果在 `out/probes/20260923-e2e-infra/`（`out/` 被 git 忽略，只在本机保留）。

## 环境

- Chrome for Testing 149.0.7827.55（`~/Library/Caches/ms-playwright/chromium-1228`），`--headless=new`；Node v22.23.1。
- 每次启动都把 `extension/dist` 复制到临时目录，并换一把新生成的 manifest key，得到新的扩展 ID。日常伴随进程清单的 `allowed_origins` 不含这个 ID，所以实验不可能拉起日常伴随进程。
- 实验期间日常伴随进程在运行（PID 75750，`agent/src/main.ts`，已运行约 2.5 小时）。

## 结果

### 1. Native Messaging：通过

- Chrome 启动后 606 ms，扩展自己的上行连接（`uplink.ts`）按 `<隔离浏览器目录>/NativeMessagingHosts/com.sideagent.host.json` 拉起了本地程序，并发来 `hello`。
- 本地程序收到的参数为 `chrome-extension://<测试扩展 ID>/`。启动 Chrome 时传入的标记变量 `SIDEAGENT_PROBE_MARK` 原样出现在本地程序里，HOME 也是继承下来的。
- 从扩展后台主动 `connectNative` 并往返一次：成功。
- 证据：`p1-native-sidepanel.json` 的 `p1_uplink`、`p1_roundTrip`。

### 2. HOME 指到临时目录：数据能隔离，但真模型和真语音会失效

| 设置 | 可用模型 | 4 个精选模型 | 本地池 | StepFun 凭据文件 | TypeSafe 凭据文件 | 默认模型设置 |
|---|---|---|---|---|---|---|
| 真实 HOME | 163 | 4/4 | 注册 22 个 | 在 | 在 | `cliproxy/mimo-v2.6-flash` |
| HOME=临时目录 | 0 | 0/4 | 未接入 | 无 | 无 | 无 |
| HOME=临时目录 + `PI_CODING_AGENT_DIR` 指回真实目录 | 141 | 3/4 | 未接入 | 无 | 无 | 无 |

- 原因：Pi 的配置目录可以用 `PI_CODING_AGENT_DIR` 单独指定，但产品自己的凭据和设置都是按 `homedir()` 找的：`~/.cli-proxy-api/client.env`（`cliproxy.ts:108`）、`~/.sideagent/stepfun-api.key`（`voice-service.ts:25`）、`~/.sideagent/typesafe.env`（`typesafe-auth.ts:10`）、`~/.sideagent/config.json`（`config.ts:54`）。
- 实验前后，`~/.pi/agent`、`~/.sideagent`、`~/.cli-proxy-api` 三个目录的文件清单、大小、修改时间都没有变化。
- 运行测试的 shell 里设置了 `STEPFUN_API_KEY`（只查了有没有，没读值），现有隔离启动器会把它从 Chrome 的环境里去掉。
- 证据：`p2-home.json`。

### 3. 真侧栏：能打开，而且和标签页里的面板不一样

- 在扩展后台里调用 `chrome.sidePanel.open`（带调试协议的用户手势）会被拒绝：“may only be called in response to a user gesture”。从扩展页调用（同样带调试协议的用户手势）则成功打开。
- 真侧栏在调试协议里是一个 `page` 类型的目标：可见、有焦点、尺寸 360×421，面板应用正常启动（`#input` 存在）。
- 「当前标签页」的差别：

| 查询 | 真侧栏 | 标签页里的面板（现有测试的开法） |
|---|---|---|
| `chrome.tabs.getCurrent()` | `null` | 面板自己这个标签页 |
| `tabs.query({active, currentWindow})` | 用户的网页 | 面板自己 |
| `tabs.query({active, lastFocusedWindow})` | 用户的网页 | 面板自己 |

- 侧栏代码有 4 处这样取当前页：页面标牌和任务条材料（`sidepanel/main.ts:1349`，`currentWindow`）、按站点列技能（`:1564`）、恢复任务的上下文（`:3482`）、活动标签页 ID（`:4030`，后三处都用 `lastFocusedWindow`）。所以在标签页里测，这 4 处拿到的“当前页”都是面板本身。
- 证据：`p1-native-sidepanel.json` 的 `p3`。

### 4. 假音频：可用，但要关掉音频服务的沙箱

- 默认情况下 Chrome 报 `Failed to read <wav> as input to the fake device. Try disabling the sandbox with --no-sandbox.`，收到的是静音。WAV 放在桌面下的仓库里和放在系统临时目录里结果一样，所以原因是沙箱，不是桌面权限。
- 加上 `--disable-features=AudioServiceSandbox`（或 `--disable-features=AudioServiceOutOfProcess`）后：
  - 16/16 帧的主频都是 659 Hz（频率分辨率 2.93 Hz，写入的是 660 Hz），产品收音参数和关掉音频处理两种情况一样。
  - 关掉音频处理时 RMS 为 0.3537，振幅 0.5 的正弦波理论值是 0.3536；开着处理时是 0.5563（自动增益放大了）。
- 对照组（Chrome 默认假设备）是 398/59 Hz 的间歇蜂鸣，和 WAV 能明确区分开。
- 证据：`p4-fake-audio.json`。

### 5. 扩展后台的回收：调试会话会让它一直不被回收

| 条件 | 扩展后台 |
|---|---|
| 无 Native 连接、没挂调试会话 | 约 30 s 被回收 |
| 挂着调试会话（`Runtime.enable`） | 观察的 65 s 内一直在 |
| 断开调试会话后 | 约 25 s 内被回收 |
| Native 连接开着、没挂调试会话、侧栏已关 | 观察的 70 s 内一直在 |

- 现有 `isolated-extension.mts` 从启动起就一直挂着调试会话，所以现有测试里扩展后台从来不会被回收，「回收后重连、回放」这条日常路径走不到。9/23 模型芯片的 bug 就出在这一步。
- 证据：`p5-sw-lifecycle.json`、`p1-native-sidepanel.json` 的 `p5c`。

### 6. 桌面下的仓库代码：可以读取，有前提

- 包装脚本放在临时目录，本地程序脚本放在仓库里（`~/Desktop`）。它被 Chrome for Testing 拉起后成功读到了 `package.json`（name=`sideagent`），往返通信也成功。
- 前提：系统隐私权限（TCC）日志显示，这条进程链归属于启动测试的终端（`com.cmuxterm.app`），这个终端有桌面访问权。换别的应用或方式来启动测试时，需要重新确认。
- p1b 第一次运行时，扩展后台上的调用卡了 30 s，本地程序也没被拉起。之后 4 次都正常（其中 3 次用同样的「刚发现后台就挂会话」顺序），原因不明，记为未复现。
- 证据：`p1b-repo-host.json`、`p1b-immediate-{1,2,3}.json`。

## 对测试基础设施方案的影响

1. **连接可以走真通道。** 隔离 Chrome 可以用真实 Native Messaging 拉起真实伴随进程，配置通过 Chrome 的环境变量传进去。不再需要在扩展后台里替换 `WebSocket`，也不需要 WS 令牌。
2. **数据隔离需要改一处产品代码，不能靠改 HOME。** 真模型和真语音要用的凭据都在家目录下。建议加一个数据目录设置，把产品会写的东西都放进去：会话、记忆、经历、技能、任务回执、`agent.log`、trace、语音采集、route-shadow、下载、上传，以及模型选择器会写回的 `config.json`。凭据仍按原位置只读。验收方法沿用 p2：跑完后日常目录的快照不变，可用模型数与日常相同。
3. **剪贴板端口要改成每个实例各用各的。** 伴随进程固定监听 `127.0.0.1:7761`（`clipboard-darwin.ts:33`），扩展也写死连这个地址（`clipboard-bridge.ts:25`）。现在这个端口被日常伴随进程占着，隔离实例绑不上，隔离扩展的粘贴会被日常伴随进程处理。系统剪贴板本身仍是共享的，粘贴类用例会改动用户的剪贴板。
4. **侧栏要在真侧栏里测。** 在标签页里，“当前页”是面板自己，和用户的实际情况不一样。
5. **语音输入可以用 WAV 驱动真实收音链路**（需 `--disable-features=AudioServiceSandbox`），配合真 StepFun 就是真语音端到端。怎么读取“产品说了什么”还没解决。
6. **启动器不要一直挂着扩展后台的调试会话**，只在需要时短暂挂上。用 Native 连接时扩展后台本来就不会被回收；要测「回收后重连」，得先断开伴随进程，再等 30 s 以上。

## 未决

- 真实 `main.ts` 在隔离实例里跑通（先要完成第 2、3 条改动）。
- 读取语音输出的办法。
- p1b 第一次卡死的原因。
- Jev 是否也按真服务处理，待用户确认。

## 复跑（脚本只在本机）

```bash
node out/probes/20260923-e2e-infra/p1-native-sidepanel.mjs
node out/probes/20260923-e2e-infra/p1b-repo-host.mjs            # P1B_IMMEDIATE=1：刚发现扩展后台就挂会话
node out/probes/20260923-e2e-infra/p2-run.mjs
node out/probes/20260923-e2e-infra/p4-fake-audio.mjs
node out/probes/20260923-e2e-infra/p5-sw-lifecycle.mjs
```
