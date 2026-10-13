# 源码安装

[文档导航](../README.md) · [使用说明](usage.md) · [开发检查](../development/checks.md)

本产品是开发预览版。本页写 macOS + Chrome 上的源码安装方式；三系统的成品分发尚未完成。产品只有扩展一种形态，不用另装本机程序。

## 1. 构建扩展

需要 Google Chrome，以及用于构建的 Node.js **22.19 或更高版本**、npm、Git。

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
```

## 2. 加载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/dist/`。
3. 点击工具栏的 **By Your Side** 图标，打开侧栏。
4. 更新源码后，重新运行 `npm run build`，再在扩展页点「重新加载」。

如果你已加载旧版，在扩展页点「重新加载」后，扩展才拿到新增的权限。

## 3. 连接模型

打开侧栏「更多 → 模型与语音」，填写文字模型的密钥。密钥只存在这个浏览器里。
扩展不读取 `~/.pi/agent/` 或 `~/.sideagent/` 里的凭据；所以用过 Pi CLI 的用户也要在设置页重新填写。

阶跃的同一个密钥能调用 Step Plan 套餐和开放平台按量两个通道。扣哪边的费用只由请求地址决定。

主模型出错时，只有在设置页选了备用模型，任务才换模型接着做，见[主任务的模型服务出错](../model-effort.md#主任务的模型服务出错)。

## 4. 可选：语音

在同一设置页填写阶跃语音密钥，也可以沿用阶跃文字模型的密钥。不连接语音，不影响文字功能。
