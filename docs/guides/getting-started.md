# 源码安装

[文档导航](../README.md) · [使用说明](usage.md) · [给 AI 助手的安装说明](install-for-agents.md)

本产品是开发预览版。Chrome 和其他基于 Chromium 的浏览器（Edge、Brave、Arc 等）都能装，系统不限；Firefox、Safari 缺侧栏和调试器接口，装不上。目前只在 macOS + Chrome 上完整测过，下面以它为例。产品只有扩展一种形态，不用另装本机程序。

也可以从 [Chrome 网上应用店](https://chromewebstore.google.com/detail/by-your-side/emmojfmjolcafmjicpdaeljfgmefacng)安装商店版，Chrome 会自动检查并安装已发布的更新。商店版汇集经过验证的改动，紧急修复可能单独发布；每次更新需经过商店审核。下面的源码安装适合想体验频繁开发更新的用户，更新后需自行构建并重新加载。

想让 AI 编程助手（Claude Code、Codex、Cursor 等）替你装，对它说这一句就行：

> 请按 https://raw.githubusercontent.com/yishu-ziyu/By-Your-Side/main/docs/guides/install-for-agents.md 帮我安装 By Your Side。

助手会下载、构建，再告诉你要点哪两处。下面是自己动手的步骤。

## 1. 构建扩展

需要 Chrome 或其他基于 Chromium 的浏览器，以及用于构建的 Node.js **22.19 或更高版本**、npm、Git。

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
```

## 2. 加载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/dist/`（不是仓库根目录）。
3. 点工具栏的拼图图标，把 **By Your Side** 固定到工具栏，再点它打开侧栏。
4. 更新源码后，重新运行 `npm run build`，再在扩展页点「重新加载」。

如果你已加载旧版，在扩展页点「重新加载」后，扩展才拿到新增的权限。

## 3. 连接模型

第一次打开侧栏时点「连接模型」，以后从「更多 → 模型与语音」进入，都会打开设置页。在服务商列表里选一家，填写密钥；OpenAI 用 ChatGPT 账号登录。密钥只存在这个浏览器里。
扩展不读取 `~/.pi/agent/` 或 `~/.sideagent/` 里的凭据；所以用过 Pi CLI 的用户也要在设置页重新填写。

阶跃的同一个密钥能调用 Step Plan 套餐和开放平台按量两个通道。扣哪边的费用只由请求地址决定。

主模型出错时，只有在设置页选了备用模型，任务才换模型接着做。

## 4. 可选：语音

在同一设置页填写阶跃语音密钥，也可以沿用阶跃文字模型的密钥。不连接语音，不影响文字功能。
