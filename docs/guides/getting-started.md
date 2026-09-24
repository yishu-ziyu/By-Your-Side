# 源码安装

[文档导航](../README.md) · [使用说明](usage.md) · [开发检查](../development/checks.md)

开发预览版，以下是现有 macOS + Chrome 源码安装方式；三系统成品分发尚未完成。

## 1. 准备环境

- macOS、Google Chrome。
- Node.js **22.19 或更高版本**、npm、Git。
- 一个 Pi 支持且已配置凭据的模型服务。模型用量由对应服务计费。

```bash
git clone https://github.com/yishu-ziyu/By-Your-Side.git
cd By-Your-Side
npm ci
npm run build
npm run install:host
```

`build` 生成 `extension/dist/`；`install:host` 安装 Chrome Native Messaging 清单与本地启动脚本。仓库移动位置或更换 Node 路径后，重新运行安装命令。

## 2. 配置任务模型

本地进程使用 Pi 的模型配置与凭据，通常位于 `~/.pi/agent/`。尚未配置时，可以运行：

```bash
npx @earendil-works/pi-coding-agent
```

在 Pi 中完成对应服务的登录或凭据设置，再选择模型。也可以通过 `~/.sideagent/config.json` 指定任务模型，例如：

```json
{
  "model": "kimi-coding/kimi-for-coding"
}
```

这是模型标识示例，需要对应账号具备访问权限。省略 `model` 时沿用 Pi 的首选配置。需要网络代理时，可在同一文件增加 `proxy`，值为可用代理 URL；不要把账号密钥写入这个文件。配置变更后重载扩展。

## 3. 加载扩展

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本仓库的 `extension/dist/`。
3. 点击工具栏的 **By Your Side** 图标，打开侧栏。

Chrome 会自动启动本地伴随进程。正常使用不需要手动启动服务或粘贴连接 token。默认扩展 ID 与 Native Messaging 白名单由仓库 manifest 对应生成。

没有安装伴随进程时，扩展会在 offscreen 文档中运行同一份任务核心。打开侧栏「更多 → 模型与语音」，配置文字模型和凭据；阶跃语音可单独填 Key，也可沿用阶跃文字模型的 Key。扩展凭据保存在 Chrome 的本地扩展存储中，不从 `~/.pi/agent/` 或 `~/.sideagent/` 自动读取。扩展入口目前的恢复与持久化边界见[当前状态](../STATUS.md)。
在设置页更换文字模型后，当前扩展会话也会更新模型；运行中的任务下一次模型调用可能使用新选择，界面会收到模型信息更新。

要让阶跃文字任务在主模型可重试故障耗尽后切换到智谱，需先在设置页保存智谱 GLM 编程版的凭据，再切回阶跃作为当前模型；备用凭据缺失时不会假装已切换。自动换模只保护任务循环内的模型失败，目标复核等独立模型调用的限制见[本轮验收](../evals/20260924-core-into-extension.md)。

## 4. 可选：启用语音

将自己的 StepFun **开放平台 API Key** 写入本机文件 `~/.sideagent/stepfun-api.key`（不是 Step Plan 套餐 Key），并限制其权限：

```bash
chmod 600 ~/.sideagent/stepfun-api.key
```

文件只保存 Key 本身，不加 JSON 包装。也支持 `STEPFUN_API_KEY` 环境变量，但它必须对 Chrome 启动的伴随进程可见。唯一语音模型为 `stepaudio-3-realtime-preview`，连接 `wss://api.stepfun.com/v1/realtime`；不再调用 2.5 Realtime 或旧 TTS。Key 只由本地进程读取，不发送到侧栏。开放平台按账号规则计费；未配置语音 Key 不影响文字功能。

## 5. 可选：启用 Jev 显示操作加速

在 `~/.sideagent/typesafe.env` 中填写自己的 TypeSafe API Key：

```dotenv
TYPESAFE_API_KEY=填写你自己的密钥
```

将文件权限设为仅自己可读写：

```bash
chmod 600 ~/.sideagent/typesafe.env
```

在已有的 `~/.sideagent/config.json` 中增加 `"displayFastPath": true`，保留其他配置，然后重载扩展。设为 `false` 即可关闭。服务使用 `jev-1.13.0`；启用后，符合入口条件的显示请求及能力说明会发送给 TypeSafe。Key 保存在本机，不写入仓库。配置与数据处理说明见 [TypeSafe 官方文档](https://docs.typesafe.ai/introduction)。

## 6. 可选：通用浏览器循环（实验）

使用同一 TypeSafe 凭据，在本地配置增加 `"generalBrowserLoop": true` 后重载扩展。缺省关闭；它与显示加速、运行中显示修改是不同开关。开启后，符合条件的任务先由 Jev 在当前页面候选中选动作，仍经原浏览器工具、权限和结果账本执行；需要内容时由任务模型准备，之后交主模型核验或继续。

这是实验能力，不能保证减少总耗时或完成任意网页任务。具体进入条件见[架构](../architecture.md)，本机是否已开、真实试用结果只在[STATUS](../STATUS.md)维护。
