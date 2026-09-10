# 真实对照脚本评审

主代理只读审查，修复与检查交DeepSeek执行。此文件记录实现缺口，不修订冻结标准。

- 初版delay_ready在载入900ms后自动就绪，模型可能从未看到不可用状态。应以首次真实观察触发，并记录观察、就绪、点击时间。
- pick_target不应要求调用名必须是click；以页面事件和最终状态判断一次副作用，保留回答原文评审，不用固定措辞淘汰同义表达。
- 同一block必须共用seed、任务和初始页面；记录harness/fixture hash及源码漂移。
- 初版将所有harness error归为infra，须区分产品断言、已知基础设施故障、待审超时。慢样本保留。
- 子进程error不保证产生exit；必须单次settle。每批独立结果目录，不能重跑覆盖。超时先清理本批资源，避免残留Chrome。
- 核心指标必须接真实协议：record_task_results是内部工具，不在browser tool_call里；应从agent_event tool_start按模型轮次计数及去重。原始ServerMessage没有at，首动作须从带时间的工具记录读取。
- turn_end没有usage字段；token从真实模型会话记录读取，取不到标not_available，不能伪报0。统计检查须使用真实协议形状的事件输入。

真实18次仍未运行。完成离线脚本审查不等于真实对照通过，也不能据此选B/C。
