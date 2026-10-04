# 源码安装

[文档导航](../README.md) · [使用说明](usage.md) · [开发检查](../development/checks.md)

开发预览版，以下是现有 macOS + Chrome 源码安装方式；三系统成品分发尚未完成。产品只有扩展一种形态：任务核心运行在扩展内，不需要另装本机程序（2026-10-01 裁决，见[路线图](../ROADMAP.md)第 9 条）。

## 1. 构建扩展

需要 Google Chrome，以及用于构建的 Node.js **22.19 或更高版本**、npm、Git。

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
```

`build` 生成 `extension/dist/`。依赖版本由仓库锁定：DOMPurify 3.4.16、Undici 8.10.2；Pi 仍为0.84.4，其嵌套依赖补丁策略见[开发检查](../development/checks.md)。无需修改全局 npm 配置。

## 2. 加载扩展

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本仓库的 `extension/dist/`。
3. 点击工具栏的 **By Your Side** 图标，打开侧栏。扩展页显示的版本应与 `extension/manifest.json` 一致（当前 0.2.0）；更新源码后重新 `npm run build` 并在扩展页点「重新加载」。

扩展从 2026-09-26 起多申请下载权限（`downloads`），用来确认页面下载是否完成；2026-10-01 起再申请「不限存储」（`unlimitedStorage`），记忆和过往任务不受浏览器默认存储配额限制，Chrome 安装时不为它额外弹提示。已加载旧版的，在 `chrome://extensions` 里对 By Your Side 点“重新加载”后才会拿到它们。2026-10-02 起 manifest 多了一个沙箱页（`sandbox.pages`，显示生成的网页）和它自己的内容安全策略，不新增权限、安装时不额外弹提示；同样要重新构建并重新加载。

## 3. 配置模型

打开侧栏「更多 → 模型与语音」，配置文字模型和凭据。模型用量由对应服务计费。扩展凭据保存在 Chrome 的本地扩展存储中，不从 `~/.pi/agent/` 或 `~/.sideagent/` 自动读取。恢复与持久化边界见[当前状态](../STATUS.md)。

阶跃文字模型（step-3.7-flash、step-3.5-flash、step-5-preview）走 Step Plan 通道 `https://api.stepfun.com/step_plan/v1`，消耗套餐 Credit；按开放平台 API 计费的只有实时语音 `stepaudio-3-realtime-preview`（不在 Step Plan 模型列表里）。同一个 Key 两个通道都能调用，扣哪边只由请求地址决定。

在设置页更换文字模型后，当前扩展会话也会更新模型；运行中的任务下一次模型调用可能使用新选择，界面会收到模型信息更新。

要让阶跃文字任务在主模型可重试故障耗尽后切换到智谱，需先在设置页保存智谱 GLM 编程版的凭据，再切回阶跃作为当前模型；备用凭据缺失时不会假装已切换。自动换模只保护任务循环内的模型失败，目标复核等独立模型调用的限制见[扩展内核验收](../evals/20260924-core-into-extension.md)。

## 4. 可选：语音

在同一设置页填写阶跃语音 Key，也可沿用阶跃文字模型的 Key。唯一语音模型为 `stepaudio-3-realtime-preview`，连接 `wss://api.stepfun.com/v1/realtime`；开放平台按账号规则计费。未配置语音不影响文字功能。

## 开发者：本机模式正在退役

旧的本机伴随进程（原 `npm run install:host`、`~/.sideagent/` 下的配置与 Key 文件、Jev 显示加速与通用浏览器循环）已于 2026-10-01 删除，不再作为使用方式提供；见[退役验收](../evals/20261001-retire-native-and-dead-code.md)。原安装步骤见本文件 2026-10-01 之前的 Git 历史。

2026-10-02 核对：扩展清单介绍已改为侧栏阅读与网页操作；清单没有 `nativeMessaging` 权限，扩展源码没有 `connectNative` / `sendNativeMessage` 调用。日常启动由后台创建 offscreen 文档，在扩展内运行 Agent。旧评测用的本机 WebSocket 回退与侧栏调试口令页已于 2026-10-04 删除（[删减验收](../evals/20261004-cut-unused.md)）；offscreen 创建失败时只按退避重试。构建不再拷贝小伙伴 M 的素材，也不再打包示范录制、观察与点选的页面脚本；不新增权限，重新构建并重新加载即可。
