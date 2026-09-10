# Pattern: 读取 Secure Preferences 前先确定实际 profile 目录

## 现象

用 python 直接 `json.load(open('<user-data-dir>/Secure Preferences'))` 抛 `FileNotFoundError`；改读 `<user-data-dir>/Default/Secure Preferences` 后成功（读到 53 条扩展记录）。

## 根因

本次实例的 `Secure Preferences` 位于 `<user-data-dir>/Default/`，原读取遗漏了 profile 这一层。其他实例应核对实际 profile 目录，不能由此断言一定是 `Default/`。

## 规避方法

排查扩展安装/消失问题时，先确认目标浏览器使用的 user-data-dir 与实际 profile，再读取其中的 `Secure Preferences`。本次已验证的 profile 是 `Default/`；列出目录只能确认候选目录存在，不能单独证明浏览器正在使用它。

## 验证

- 失败：源会话 wire.jsonl **1947→1948**（根目录路径 FileNotFoundError）。
- 成功：**1963→1964**（`Default/Secure Preferences`，total: 53）。

## 适用条件

macOS 上脚本化检查 Chrome/Chromium 系浏览器扩展状态。NOTES.md:310 提到过 Secure Preferences 但未记 `Default/` 这一层路径，本页补齐。

## 相关未决问题（勿固化）

「Chrome 重启后扩展消失」的根因在该会话中**未被证实**：证据只到 `getExtensionsInfo` 查无 SideAgent ID（2079）、reload 接口报 not found（2063）、Secure Preferences 只剩骨架条目（1974）。NOTES.md:310 的「清理旧 ID 时误删」只是推断，维持未决。

## 文档卫生备注

`docs/NOTES.md:270` 把重载脚本写成 `scripts/reload-ext.mts`，实际落盘与 package.json 注册的是 `scripts/reload-ext.mjs`（源会话 wire 2156–2158 创建、2172 注册；仓库现状亦为 `.mjs`）。本 agent 无文档写权限，留待用户顺手修正。

## 来源

- 复盘会话：session_f0b4980d-5078-4b2d-9712-034c6553c988（2026-09-09）
- 证据会话：session_236968c3-8bae-437a-9311-3bdccc4df91b，行号见上
