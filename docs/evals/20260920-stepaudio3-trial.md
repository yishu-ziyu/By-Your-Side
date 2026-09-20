# 任务：用户能打开独立的 Realtime 3 试用侧栏，边执行网页任务边交谈

## 完成标准

- [x] 1. 独立浏览器资料目录、扩展副本、伴随进程端口和会话存储；日常 2.5 进程/配置/扩展不重载。— 谁检查：主代理，启动记录和进程参数
- [ ] 2. 实际加载 3-preview，能从试用侧栏主动开启麦克风、播放回答、停声和结束通话；不给网页 API 密钥。— 谁检查：主代理无头协议/界面检查；真实声学由用户
- [ ] 3. 语音请求进入现有 ConversationManager 的真实网页任务链；闲聊/停声不取消后台任务。展示真实进展，不用模拟结果。— 谁检查：主代理独立浏览器真实页面变化/事件；用户实际插话体验
- [ ] 4. 显示接话等待等实测状态，不把生成完成当播放完成；未测的自然程度和理解率明确未测。— 谁检查：代码/事件，用户体验
- [ ] 5. 试用默认允许读取、翻译与可逆显示修改；提交、付款、任意脚本等未审操作在宿主硬阻断，模型不能自行授权。— 谁检查：拒绝反例和实际入口
- [x] 6. 留下打开与停止入口；窗口交到用户之前，启动及基础连通自检通过。— 谁检查：主代理

## 边界与不做

- 用户已明确要求执行独立试用版并能亲自体验，不再停在方案复述。现有探针和研究保留，见 `20260920-stepaudio3-validation.md`。
- 使用独立 Chrome for Testing 资料目录中的扩展副本和真实侧栏；不连接用户 ChromeMain、不迁移登录态、不替换日常版本，不新增 Git 工作树。
- 只在试用启动代码/前端中增加 3 通道，不将实验协议写入默认生产语音入口。现有任务执行模型不自动更换为 3。
- 麦克风由用户点击开始后申请；不自动录音，不保存原始音频。自动检查无头、无扬声器，不冒充真人体验。用户试用入口可以是明确可见的独立窗口。
- 前期采取更保守的操作限制：阅读/翻译/显示变化可体验；提交、付款、表单写入及任意脚本不放开。此限制明确显示在试用界面，不称为完整权限接入。
- 不是宣布 3 更优；交付可体验入口和少量实测数据，再由用户决定。

## 本轮交付与实测

已打开**可见的独立试用窗口和真实侧栏**，顶部「Realtime 3 · 独立试用」。用户点击才授权/开启麦克风；没有自动录音或播放可见窗口的声音。语音用 3-preview，网页执行仍为原任务模型 MiniMax-M3，并非把全部推理替换成 3。

- 启动命令：`node --import tsx scripts/experiments/realtime3-trial/start.mts --visible --out out/experiments/realtime3-live3`。
- 可见窗口记录：`out/experiments/realtime3-live3/ready.json`；本轮启动 pid 98914，浏览器 pid 98971；页面 `http://127.0.0.1:53469/`。端口/进程只代表本次运行，重启以 ready.json 为准。
- 主代理实际核对 360px 侧栏无横向溢出、旧语音入口隐藏、原任务引擎已连通、麦克风/语音尚未开启。`ui-check.json`、`panel.png` 同目录；已亲自查看截图。
- 无头静音真实链路：`node out/experiments/check-realtime3.mjs out/experiments/realtime3-smoke5`；结果 `out/experiments/realtime3-smoke5/check.json`。确认 3 实际返回模型、server_vad、音色及 PCM；文字输入产生助手转写和语音输出/播放完成事件；“把当前网页原地翻译成中文”经真实任务引擎使四段英文正文出现中文翻译，不是固定模拟结果。
- 检查在正文变化后结束通话；其后仍收到原任务完成的 finding（`events.jsonl` 中 `task_delivery`，outcome:complete），说明这个实测路径中结束通话没有取消任务。尚未验证真人说话期间的附和/打断区分。
- 无头检查进程 pid 97381 已核对命令后停止，不留后台测试占用。可见试用保持运行交用户。
- 主代理定点检查 `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --lib ES2022,DOM,DOM.Iterable scripts/experiments/realtime3-trial/ui.ts scripts/experiments/realtime3-trial/voice-server.mts` 通过；`git diff --check` 通过。入口实际启动通过；入口全依赖 strict tsc 仍有旧 acceptance runner 类型断言及 JS 声明缺失，未包装成全工程类型检查通过。

## 失败、修正与未完成

- 本机旧 Playwright 浏览器缓存已不存在。没有改用日常 Chrome；将官方 Chrome for Testing 153.0.8010.52 下载/解压到隔离 `out/experiments/realtime3-browser`，不写系统应用目录。
- 启动时误选 Chrome 内置组件 service worker，误报 Chrome API 未就绪；改为核对试用扩展 manifest 名称后绑定。原失败保留 smoke/smoke2/smoke3/smoke4 目录。
- 第一份检查用折叠区 innerText，因 details 折叠读不到已有回复而超时；改为读 textContent 并要求新增转写节点。原 `check-first-collapsed-text.json` 保留，未归因模型失败。
- service worker 的 Runtime.evaluate 即便标记 userGesture，也不能打开侧栏。两次可见启动失败保留 live/live2；最终通过独立扩展页按钮的实际点击打开侧栏，live3 就绪。
- 独立复核发现并修正旧 ASR 候选/固定去重 id，以及 stop_speech 在 response.created 之前的竞态。执行子代理用临时假 socket 反例复验；不是声学效果通过。
- 顶部新增麦克风路径复用原产品的**完整授权页**，避免侧栏第一次申请权限无提示；权限申请只能由用户点击。实际设备与 macOS 权限由用户检验。
- 标准 2–5 保持未勾选：已交付相应代码及部分链路证据，但真人声学、边做边说、实际打断停声时间、授权阻断端到端反例尚未全部完成。当前允许的动作在宿主代码白名单控制，所有其他工具回 not_executed；不声称付款保护已完整产品验收。
- 不宣布完整任务达标或 3 胜过 2.5。当前交付是**已打开、已跑通基本真实链路的试用入口**，接下来接收用户体验，而非继续铺设测试设施。

打开/结束方法见 `scripts/experiments/realtime3-trial/README.md`。旧研究和约两千行比较准备仍保留，不丢弃。
