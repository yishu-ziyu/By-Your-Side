# 源码安装

[文档导航](../README.md) · [使用说明](usage.md) · [开发检查](../development/checks.md)

开发预览版，以下是现有 macOS + Chrome 源码安装方式；三系统成品分发尚未完成。产品只有扩展一种形态：任务核心运行在扩展内，不必另装本机程序（见[路线图](../ROADMAP.md)第 9 条）。

## 1. 构建扩展

需要 Google Chrome，以及用于构建的 Node.js **22.19 或更高版本**、npm、Git。

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
```

`build` 生成 `extension/dist/`。依赖版本由仓库锁定，不必修改全局 npm 配置。

## 2. 加载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/dist/`。
3. 点击工具栏的 **By Your Side** 图标，打开侧栏。扩展页显示的版本应与 `extension/manifest.json` 一致；更新源码后重新 `npm run build` 并在扩展页点「重新加载」。

扩展申请的权限见[数据和权限](usage.md#数据和权限)。其中「不限存储」（`unlimitedStorage`）让记忆和过往任务不受浏览器默认存储配额限制，Chrome 安装时不为它额外弹提示。已加载旧版的，在扩展页点「重新加载」后才会拿到新增的权限。

## 3. 配置模型

打开侧栏「更多 → 模型与语音」，配置文字模型和凭据。模型用量由对应服务计费。扩展凭据保存在 Chrome 的本地扩展存储中，不从 `~/.pi/agent/` 或 `~/.sideagent/` 自动读取。恢复与持久化边界见[当前状态](../STATUS.md)。

阶跃文字模型走 Step Plan 通道，消耗套餐 Credit；按开放平台 API 计费的只有实时语音（不在 Step Plan 模型列表里）。同一个 Key 两个通道都能调用，扣哪边只由请求地址决定。

在设置页更换文字模型后，当前扩展会话也会更新模型；运行中的任务下一次模型请求可能使用新选择。

阶跃文字任务可在主模型的可重试故障耗尽后切换到智谱。要启用这项切换，应先在设置页保存智谱 GLM 编程版的凭据，再把主模型切回阶跃。备用凭据缺失时，扩展不会假装已切换。自动换模只保护任务循环内的模型失败；目标核对等独立模型请求的限制见[扩展内核验收](../evals/20260924-core-into-extension.md)。

## 4. 可选：语音

在同一设置页填写阶跃语音 Key，也可沿用阶跃文字模型的 Key。实时语音由开放平台按账号规则计费。未配置语音不影响文字功能。
