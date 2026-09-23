# Pattern: 源码旁的旧 .js 会被 esbuild 打进扩展，tsx 却用 .ts

## 现象

`shared/` 里出现 32 个未跟踪的 `.js`（和 `.ts` 同名）。伴随进程行为符合 `.ts` 源码，扩展行为却可能是旧的，两边对不上。

## 原因

源码里写的是 `import ... from "./protocol.js"`。esbuild 解析时，磁盘上真有 `protocol.js` 就直接用它，不去找 `protocol.ts`；tsx 反过来优先 `.ts`。所以同一份导入，扩展构建和伴随进程拿到的是不同文件。本例有 7 个 `.js` 比对应 `.ts` 旧（`shared/control`、`execution-feedback`、`network`、`observe`、`pointer-input`、`protocol`、`task-view`），扩展里跑的就是旧逻辑。

## 方法

- 构建或验收前列出 `git ls-files --others --exclude-standard 'shared/*.js' 'extension/src/**/*.js'` 里有同名 `.ts` 的文件，并比较修改时间；样板脚本 `scripts/acceptance/real-path/harness.mts` 的 `shadowedSources()` 会把这份清单写进 `result.json`。
- 这些文件多半是别的会话或工具误编译产生的；删除前先确认来源，不要替别的会话清理。

## 适用条件

esbuild 走默认解析、`.js` 与 `.ts` 同目录同名时；两种优先顺序都经 2026-09-23 的小实验确认。

## 验证与来源

- [第一条真实路径样板用例](../../../docs/evals/20260923-real-path-first-case.md)「发现但未处理」；每次运行的 `result.json` `environment.staleJsInExtensionBuild`。
- 2026-09-23，本轮主代理。
