# 任务：用实验决定重构用 Pi 1.0 核心加我们自己的存储，还是用 pi-durable

现状：扩展锁定 Pi 0.84.4；Pi 1.0（10-01）删掉了我们用的会话存储接口。pi-durable：[npm](https://www.npmjs.com/package/@earendil-works/pi-durable)

## 规则

- R1 打包：pi-durable 1.0.x 和 pi-agent-core 1.0.3 能按扩展的打包设置（esbuild，browser 平台）打出来，产物里没有 `node:` 引入；如果有，记下来源和需要的替身。机器检查：探针脚本输出。
- R2 真实跑一轮：在无头 Chrome 的扩展页面里，pi-durable 配上一个基于 IndexedDB 的存储，用 gpt-6-luna（ChatGPT 登录）答一句话，并调用一个页面工具。机器检查：探针脚本输出，加截图。
- R3 中断恢复：工具执行到一半时重载页面，重新打开以后，会话记录还在；没声明可以重放的工具得到「被中断」结果，不会重做。机器检查：探针脚本输出。
- R4 代价：记下首字时间和每轮多出的存储写入，和直接用 pi-agent-core 1.0.3 跑同一句话做对比。机器检查：探针脚本输出。

## 还没答上的问题

无。

## 技术前提

- 前提：pi-durable 的 JSONL、SQLite 存储核心不依赖 Node（README 写明需要我们提供文件系统或异步 SQLite 接口）。小实验：R1 打包探针（不超过 50 行）。结果：待测。

## 边界与不做

- 只做实验，不改主线依赖版本，不迁移已有会话。
- 不刷新 ChatGPT 登录令牌；令牌 3 小时内过期就停下。
