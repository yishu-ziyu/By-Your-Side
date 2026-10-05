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

- 前提：pi-durable 的 JSONL、SQLite 存储核心不依赖 Node（README 写明需要我们提供文件系统或异步 SQLite 接口）。小实验：[R1 打包探针](../../scripts/probes/pi1-durable/r1-bundle.mjs)（45 行）。结果：通过（见 R1 证据）。

## 边界与不做

- 只做实验，不改主线依赖版本，不迁移已有会话。
- 不刷新 ChatGPT 登录令牌；令牌 3 小时内过期就停下。

## 证据

2026-10-06 实测。脚本在 [scripts/probes/pi1-durable/](../../scripts/probes/pi1-durable/)（独立 package.json，`npm install --legacy-peer-deps`）；结果 JSON 同时存在该目录 `results/` 和 `out/pi1-durable/`。版本：pi-durable 1.0.2，pi-agent-core 1.0.3，pi-ai 1.0.3，chord 1.0.3。

- R1 通过。命令：`node r1-bundle.mjs`。结果：`out/pi1-durable/r1-result.json`。
  - 只用 codex 服务商时，不 external 也能打包；产物里没有静态 `node:` 引入。大小：压缩 437 KB，不压缩 1069 KB。
  - 剩下的 `node:` 都在运行时判断之后，浏览器里不执行：`utils/provider-env.js` 的 `require("node:fs")`（只在 Bun 下）；`process.getBuiltinModule("node:os"/"node:zlib")`。
  - 像扩展现在这样静态打进 codex 登录模块（`registerBundledOAuthFlowLoaders`）时，`auth/oauth/callback-server.js` 静态引入 `node:http`，ESM 产物加载会失败。一个替身（`createServer` 直接报错）可以去掉它。`node:crypto` 是带判断的动态引入，扩展已有替身。
  - 登录模块默认按变量路径动态加载，浏览器里找不到文件。实验里用自己的 `auth.oauth` 代替：只读访问令牌，刷新直接报错。
- R2 通过。命令：`node drive.mjs --headless r2`。结果：`out/pi1-durable/r2-result.json`，截图 `out/pi1-durable/r2-screenshot.png`。
  - 存储：pi-durable 的 JSONL 核心，加我们写的 IndexedDB 文件外观（[idb-fs.ts](../../scripts/probes/pi1-durable/idb-fs.ts)，只实现 JSONL 用到的 11 个方法）。没选 SQLite：浏览器里要另带 SQLite wasm。
  - gpt-6-luna（thinking low，SSE）调用 `page_title` 一次，回答 “Spike Page 7”。会话记录：user → system → assistant(toolCall) → tool-result → assistant。
  - 一致性套件：`npx vitest run`（fake-indexeddb），23/23 通过。注意：把追加写改成什么都不做，套件仍然 23/23 通过。所以它不检查落盘，落盘只由 R3 证明。
- R3 通过。命令：`node drive.mjs --headless r3`。结果：`out/pi1-durable/r3-result.json`。
  - 8 秒的 `slow_lookup` 执行约 1.5 秒时重载页面。重新打开后，记录里有 user、system、assistant(toolCall)；待办里有 1 个 `pi.tool`（pending）和 1 个 `pi.generation`（waiting）。
  - `resume()` 后 1.4 秒空闲。工具结果是 `isError: true`，诊断码 `interrupted`，保留了中断前的输出 “looking up...”。模型按提示回答 “TOOL FAILED”。
  - 工具一共只执行 1 次，调用编号只有原来那一个：没有重做。
  - 插话：`node drive.mjs --headless steer`，结果 `out/pi1-durable/steer-result.json`。工具执行中用 `whenBusy: "steer"` 插话。插话排在工具结果之后，同一次运行接着回答 “The code word is PELICAN. BANANA”。两次提交都是 done，工具只执行 1 次。
- R4 通过（已测出数字）。命令：`node drive.mjs --headless r4`，跑两批，每批每种 3 次，交替执行。结果：`out/pi1-durable/r4-result-batch1.json`、`r4-result-batch2.json`。同一句话：调用 `page_title` 再回答，两轮模型请求。
  - 首字时间（第一条助手消息出现，单位 ms）：pi-durable 1546–2177，中位 1764；裸 Agent 1220–4993，中位 1641。总耗时中位：3354 对 3380。差别在网络波动之内，3+3 次分不出来。
  - 存储写入：pi-durable 每次运行 56 个 IndexedDB 事务、16.6 KB（两轮，每轮约 28 个事务、8.3 KB）。打开新库另有 7 个事务。裸 Agent 不写存储（我们现有的会话存储写入量这次没测）。
  - 自身开销（假模型，瞬时回答，各 10 次，`node drive.mjs --headless faux`，`out/pi1-durable/r4-faux-result.json`）：pi-durable 中位 13 ms（11–29），52 个事务；裸 Agent 0–1 ms。
  - 流式输出：pi-durable 的半截回答最多每 100 ms 提交一次（README），短回答在界面上看不到逐字更新事件，只看到整条消息。

结论（推断，待主代理裁决）：技术上 pi-durable 能在扩展页面里跑通，中断恢复和插话符合预期，延迟代价可以忽略。风险在于 API 标明实验性、浏览器存储要自己写和测、我们的运行循环要整体改成它的扩展和钩子。
