# 日常经历积累

[文档导航](../README.md) · [架构](../architecture.md)

用户于 2026-09-16 授权启用。服务读取正式宿主已有的 `~/.sideagent/experiences/*.json` 完成记录，后台交给 EverOS，不等待生成技能才开始积累。

安装位置为 `~/.sideagent/everos/`；服务脚本为仓库 `bridge.py` 的安装副本。LaunchAgent `local.by-your-side.everos` 在登录后恢复。上游固定为 `5076683ab88d714390573d8f88ff3c470e51129a`，独立 Python 3.12 环境安装该源码及 fastembed；不要使用临时实验环境。

## 查看与关闭

```sh
~/.sideagent/everos/venv/bin/python ~/.sideagent/everos/control.py status
~/.sideagent/everos/venv/bin/python ~/.sideagent/everos/control.py off
~/.sideagent/everos/venv/bin/python ~/.sideagent/everos/control.py on
```

关闭停止采集和整理，保留已有积累。重新开启从该时刻之后的新任务开始，不批量补入停用期间或启用前的任务。配置不包含明文模型密钥；服务启动读取现有 Pi 的 OpenCode Go 凭据。

`control.json` 保存开关/启用时刻/端口；`ingestion.json` 保存任务接收进度；`memory/` 保存 EverOS 的 Markdown 和索引。`processed` 仅表示收到处理回执，不代表生成技能或任务成功。`needs_check` 表示一次接收结果不确定，不盲目重复上传；先核对 EverOS 同名 session 的落盘结果。

## 当前边界

- 只读产品已经记录的任务目标、工具回执与用户纠正；不遍历网页、聊天文件或截图。
- 保留未知/中断/失败；没有调用参数就不补造。敏感凭据类任务跳过，已知密钥格式脱敏。任意未标识秘密无法保证识别，应使用关闭开关暂停积累。
- 站点分区；关闭画像推断、预测和定时反思。案例和技能可以后台生成，但不直接注入日常执行，不修改 `~/.sideagent/memory/memories.json`。
- 使用当前已配置的 OpenCode Go/deepseek-flash 做整理，本地中文 embedding；512 维补零至此版本上游表结构的 1024 维，保留余弦相似度。
- 本地 HTTP 仅绑定 127.0.0.1；不对外发布服务。不要复制成公网服务。
- 所有任务处理按顺序进行；远端失败延后重试，不影响浏览器执行。中途退出保留进度，已处理任务不重发。

验收见[启用记录](../evals/20260916-everos-enable.md)。升级时先停用、替换已验证版本与脚本，再启用；不要覆盖旧数据或拉取浮动上游版本。
