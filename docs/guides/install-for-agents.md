# 给 AI 助手的安装说明

[源码安装（给人看）](getting-started.md) · [使用说明](usage.md)

这一页写给替用户安装 By Your Side 的 AI 编程助手（Claude Code、Codex、Cursor 等）。用户只需要对助手说：

> 请按 https://raw.githubusercontent.com/yishu-ziyu/By-Your-Side/main/docs/guides/install-for-agents.md 帮我安装 By Your Side。

## 目标

做完时，用户的浏览器工具栏里有 By Your Side 图标，点开能看到侧栏，并且用户知道去哪里连接模型。

你负责下载源码、构建，并带用户完成两次点击。浏览器的「开发者模式」开关和选文件夹的对话框只能由用户自己点，你做不了。

## 不要做的事

- 不要向用户要模型密钥，也不要替用户填写。密钥由用户在扩展的设置页里自己填，只存在用户的浏览器里。
- 不要读取或修改浏览器的配置目录、Cookie 和登录状态，也不要用命令行参数启动浏览器去加载扩展。新版 Chrome 不支持命令行加载扩展，而且这样装上的扩展不在用户日常使用的浏览器里。
- 不要在用户没同意时安装系统软件（Node.js、Git）。缺的话先说缺什么、打算怎么装，等用户同意。
- 不要关闭任何安全设置，不要跳过报错继续往下走。

## 第 1 步：确认环境

1. 浏览器：问用户平时用哪个浏览器。只支持 Chrome 和其他基于 Chromium 的浏览器（Edge、Brave、Arc 等）。如果用户只用 Firefox 或 Safari，告诉用户装不上，并停在这里。
2. Git：运行 `git --version`。
3. Node.js：运行 `node -v`，要求 **22.19 或更高**。版本不够或没有时，推荐用户从 nodejs.org 装 LTS 版，或用已有的版本管理工具（nvm、fnm、Homebrew、winget）。

## 第 2 步：下载并构建

在用户同意的目录里（默认用户主目录）运行：

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
```

成功的判断：`extension/dist/manifest.json` 存在，构建输出最后一行是「dist/ 构建完成」。失败时把报错的关键几行给用户看，不要改仓库代码去绕过。

记下 `extension/dist` 的**绝对路径**，下一步要用。

## 第 3 步：带用户加载扩展

先把 `extension/dist` 的绝对路径复制到剪贴板（macOS 用 `pbcopy`，Windows 用 `clip`，Linux 用 `wl-copy` 或 `xclip`），然后把下面几步原样告诉用户，一次给完：

1. 在浏览器地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」。在弹出的选文件夹窗口里粘贴刚复制的路径：macOS 先按 `⌘⇧G` 再粘贴；Windows 粘贴到窗口顶部的地址栏。选中 `dist` 文件夹，点「选择」。
4. 点工具栏的拼图图标，把 By Your Side 固定到工具栏，再点它打开侧栏。

请用户确认看到了侧栏。你看不到用户的浏览器，所以只以用户的确认为准。扩展页如果出现红色报错，请用户把报错文字发给你。

## 第 4 步：告诉用户怎么连接模型

侧栏第一次打开时有「连接模型」按钮。点它会打开设置页，在服务商列表里选一家，填自己的密钥；OpenAI 用 ChatGPT 账号登录，不用密钥。到这里安装完成，后面的事由用户自己操作。

## 以后怎么更新

在同一个目录里运行下面几行，再请用户在 `chrome://extensions` 里点 By Your Side 卡片上的「重新加载」按钮：

```bash
git pull
npm ci
npm run build
```

## 常见问题

| 现象 | 原因和做法 |
|---|---|
| `npm ci` 报 Node 版本不符 | Node.js 低于 22.19，先升级 |
| 选文件夹后提示「清单文件缺失」 | 选错了目录，要选 `extension/dist`，不是仓库根目录或 `extension` |
| 工具栏找不到图标 | 扩展默认收在拼图图标里，固定到工具栏即可 |
| 更新后功能没变 | 没在扩展页点「重新加载」 |
