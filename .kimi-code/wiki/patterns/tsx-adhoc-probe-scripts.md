# Pattern: 一次性 tsx 探针脚本的三个坑（内联 eval / .ts 后缀 / /tmp 裸导入）

## 现象

在本仓库（npm workspaces + tsx 驱动 TS）写一次性 CDP/验证探针脚本时，同一类失败连踩三次：

1. 一次 `npx tsx -e` 调用报 `Cannot find module './extension/src/background/axtree.js'`。这是该次导入解析失败，不能从调用栈出现 CJS register 推断 `import` 语法不可用。
2. 改为落盘后，`npx tsx /tmp/xx.ts` 报 `Top-level await is currently not supported with the "cjs" output format`（/tmp 下没有 package.json 的 `"type"` 上下文，`.ts` 被当 CJS 输出）。
3. 改成 `.mts` 后缀后，裸包名 `import "ws"` 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'ws' imported from /private/tmp/xx.mts`（/tmp 不在项目 node_modules 解析链上）。

## 根因

- 第一例同时改了执行方式和导入路径才成功，轨迹不能单独证明是哪一个变化解决问题，更不能证明 tsx 内联求值不支持 `import`；
- `.ts` 文件的 ESM/CJS 判定依赖所在目录树的 package.json，/tmp 下无此上下文，默认 CJS，故 top-level await 报错；
- Node 的裸包名解析从脚本所在目录向上找 node_modules，/tmp 下解析不到项目依赖。

## 规避方法与证据边界

先区分导入路径、模块格式和依赖位置三个问题：

1. 导入失败先读完整报错、核对目标路径。本例落盘并改用项目源码绝对路径后成功；这是一条已验证替代路径，不构成禁用 `tsx -e` 的依据。
2. 外部临时 TS 脚本需要 top-level await 时，用 `.mts` 明确 ESM。原轨迹证明改后缀后不再报 CJS 格式错误，但接着仍有依赖错误。
3. 需要项目依赖时，优先沿用项目内脚本位置与解析方式。放在 `/tmp` 时额外核对依赖是否可解析，不能假设当前工作目录能替它解析包，也不能假设所有包都有 `node_modules/<pkg>/index.js` 入口。

项目已有 `scripts/acceptance/` 中的 `.mts`/`.mjs` 脚本可作位置与格式参考；文件数量或惯例本身不证明所有替代写法都失败。

## 验证

- 失败：源会话 wire.jsonl **1545→1546**（指定模块未找到）、**1881→1882**（top-level await CJS 错）、**1890→1891**（ERR_MODULE_NOT_FOUND ws）。
- 成功：1553→1554（落盘 + 源码绝对路径导入，输出 refCount: 98）。1913 改用内置 WebSocket 后，1923→1924 能执行脚本，但返回 `chrome.runtime.reload is not a function`，扩展重载仍未成功。最终项目内重载脚本在 **2217→2218** 才报告重载成功。
- 2026-09-09 主代理反例检查：`npx tsx -e 'import { readFileSync } from "node:fs"; console.log("INLINE_IMPORT", typeof readFileSync)'` 输出 `INLINE_IMPORT function`，退出 0，推翻初稿的“内联 import 不可用”。初稿保留在本地 consolidate-first-draft.log，报告保留在 consolidate.log，未据此启用任何 skill。

## 适用条件

本仓库或同类 npm workspaces + tsx 项目下写一次性调试/验收探针脚本。长期脚本不适用（应放 scripts/ 内，正常解析）。

## 来源

- 复盘会话：session_f0b4980d-5078-4b2d-9712-034c6553c988（2026-09-09，只读复核）
- 证据会话：session_236968c3-8bae-437a-9311-3bdccc4df91b，wire.jsonl 行号见上
- 本轮定点查阅未找到上述模块格式与依赖位置失败链的说明；不据此断言所有历史文档都没有相关内容。
