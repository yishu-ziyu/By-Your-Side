# 原生侧栏重开与草稿隔离

DeepSeek 独占 Chrome，通过原生 cua_repl 操作已安装 By Your Side。实际调用与 receipt 确认 opencode_go/deepseek-flash，execute 开启 computer_use。

- 关闭后重开：新会话空闲，未出现旧 aborted team 卡（14-step1-reopened-settled）。
- 唯一会话收到“只回复AUDIT-DRAFT-913，不操作网页”，实际回复 AUDIT-DRAFT-913。
- 输入未发送草稿 `DRAFT-LOOP-913：只改南京，不保存`，新建会话后输入框为空（14-step2-draft-typed / new-session）。
- Worker 在原生会话下拉菜单取样/选择中达到650秒预算，未完成最后一步，不把超时计作通过。
- 主代理恢复原生取图服务后切回唯一会话，精确草稿恢复，未发送，fixture事件0（14-step2-draft-restored-by-main）。因此整条隔离路径由 Worker 与主代理共同完成。

控制器焦点异常期间曾打开非敏感本地测试URL的搜索页，已原生返回；不是产品 Agent 的网页操作，也不算产品失败。
