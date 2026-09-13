# 原生入口验收

- DeepSeek execute 使用原生 cua_repl 完成扩展重载和模型菜单开启，连续出现焦点/坐标 noWindowsAvailable 后由主代理取消，约357秒；不能算整条通过。receipt确认 opencode_go/deepseek-flash 与真实MCP调用。
- 主代理重新连接并重建本地Computer Use服务，旧窗口仍存在键盘取样问题。通过Chrome原生“文件→打开新的窗口”建立专用测试窗口后键盘恢复，未切换为CDP或脚本控制。
- 127.0.0.1:48765/?scenario=a&case=maintainability：已连接；搜索DeepSeek只见匹配项；Escape首次清空搜索、第二次关闭；鼠标选择当前模型关闭菜单；Down/Return键盘选择也关闭且保持原模型。证据ui-search / ui-escape-clear / ui-escape-close / ui-selected-current / ui-keyboard-select。
- 发“只回复：整理验收通过。不操作网页。”，收到“整理验收通过。”；表单空白、未保存、事件0，见ui-final-reply.txt/.png。
- 未改变用户默认模型；没有开启麦克风或执行真实业务写入。没有把新测试窗口的成功写成所有旧窗口控制器问题永久修复。
