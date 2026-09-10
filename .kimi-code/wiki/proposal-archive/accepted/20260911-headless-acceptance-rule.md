# 提案：验收脚本不得启动可见窗口（已采纳）

状态：**已采纳**（2026-09-11，用户裁决）。落地结果见文末。

## 建议

在 `AGENTS.md` 的「项目检查入口」里加一句约束：

> 浏览器验收默认无头运行（`--headless=new`，不创建窗口），脚本在没有无头参数时拒绝运行；
> 涉及可见运动/动效的检查单独安排并先取得用户同意，不得靠 `--window-position` 之类方式隐藏窗口。

## 依据

2026-09-11 示范录制验收跑了十来次可见 `Chrome for Testing` 窗口，每次抢用户前台 2–3 秒，
用户明确表达不满。详见 [模式页](../../patterns/gui-test-window-steals-focus.md)。

## 影响

- 新增一句约束；不影响既有 `accept:browser` / `accept:team` / `accept:sessions`（它们连用户日常 Chrome，不新起窗口）。
- 若某条验收确实需要可见窗口，按「先问用户」处理。

## 不做

- 不改验收脚本模板、不安装 skill、不修改既有通道。

## 落地（2026-09-11）

- 修改文件：`AGENTS.md`「项目检查入口」新增该条约束，按上文原文落地。
- 检查：`git diff AGENTS.md` 仅新增这一条；逐文件核对 `scripts/acceptance/` 无启动可见窗口者——自起 Chrome 的脚本都带 `--headless=new`，`accept:browser` / `accept:team` / `accept:sessions` 与语音类脚本连已运行的 Chrome，`parent-tab-model-run.mts` 的 `spawn` 是 agent worker 不是浏览器。
- 附带：新增的项目 skill `.pi/skills/sideagent-dev/SKILL.md` 同步写入了这条硬规矩。
