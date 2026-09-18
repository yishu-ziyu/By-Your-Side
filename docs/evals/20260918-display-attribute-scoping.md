# Ticket 7：显示修改不得改变未指定的属性

日期：2026-09-18。基线：本会话全部未提交改动（review 五项修复 + 预算/契约轮）。任务模型：`opencode-go/deepseek-flash` 周限额耗尽（429），按用户指示换 `minimax-cn/MiniMax-M3`（仅验收运行经 `SIDEAGENT_ACCEPTANCE_MODEL` 传入，日常配置未改）。

## 反例重建与两个检查的分离

已保存反例 `out/acceptance/jev-display-steering-1789734088114` pair-0-off：初始仅译文＋原字体，用户只要求宋体，模型单次调用提交 `{action:'display',mode:'bilingual',fontFamily:'songti'}`，执行层照做 → 页面被判错。

- **检查一（执行层省略字段是否保留原值）**：`extension/src/shared/page-translation.ts` 的 display 分支为 `if (command.fontFamily)` / `if (command.mode)` 条件赋值——**省略即保留，执行层无缺陷**。定点测试 `display-steering.test.ts`「Ticket 7」describe 以会话夹具（与真实语义一致）钉死：只带字体不改模式、只带模式不改字体、组合请求两项生效（验收表行 1/2/4）。
- **检查二（模型为什么多带字段）**：工具说明未写「省略＝保持现状」且 mode 列首位；模型填了未要求的 mode。修正：tools.ts display 说明增加 "submit ONLY the fields this request changes; omitted fields keep the current page state"；`STEER_CONTRACT_NOTE` 增加「页面显示类修改只提交本次要求改变的字段，未提到的显示属性保持当前状态」。

## 追加发现并修复：早期限制的优先语义

MiniMax 系统性欠执行「已有译文请只显示译文。」（两个独立样本同形态）：思考原文显示它以原任务「不要修改网页上的任何内容」为由整体跳过显示修改（`out/acceptance/jev-display-steering-1789738958138` 等 pair-1-off thinking）。契约补充一般性优先条款：最新输入里明确的修改要求优先于任务早期的限制，按其指明的属性执行；未指明的属性仍受早期限制约束。修复后 pair-1-off 第三个样本通过。

行 5（局部范围约束不被新要求误拦、新明确要求解除）已有 `preserves a partial-scope fallback while a later whole-page request clears it` 覆盖，未改动。

## 验证结果

- 定点（修复前模型面两条断言失败 → 修复后全过）：`display-steering.test.ts` 32 项、相关 4 文件 68 项；全量 `npm run check` 退出 0（215 文件 2061 项 + 规模 2 项）。
- 三对抽查（MiniMax）：6/6 页面状态与属性域正确、原任务均交付；2 臂挂在 summary 行 >40 字（MiniMax 把状态说明粘在「概括：」同一行，违反 fixture 明文「各用独立一行」——ruler 未放宽）。
- 全量 10 对＋6 边界（MiniMax，`out/acceptance/jev-display-steering-1789739945346/`）：
  - **Ticket 7 目标全达成**：20 臂无任何「未要求的属性被改变」；原始反例 pair-0-off 与欠执行反例 pair-1-off 均全项通过；属性域检查（行 1–4）全部正确。
  - 剩余失败均为 MiniMax 的行为/习惯类别，已逐一定位：summary 粘行超限（pair-0-on/1-on/2-off）、缺命名行或未交付（pair-2-off 自称看不到正文、pair-3-off/8-off 空交付）、该 display 却 translate（pair-5-off，noRetranslation 正确拦截）、过期 document 被拒后错误地走重译恢复（pair-6-on，闸门按设计工作）、交付归属失败（pair-3-off/4-off/8-off、礼貌/纯否定边界）——最后一类已证实为**配对串行窗口的归属缝隙**：混入交付的 runId/会话属于上一臂、内容是其答案、在其自身会话合法合成，仅 flush 晚 1.6s 落入下一臂窗口（生产多会话下属正常后台流量，非跨会话交付缺陷）。
- 命令与退出码：`npm run check` exit 0；抽查 exit 1（2 臂 summary 格式）；全量 exit 1（上述 MiniMax 类别）。日志在 `out/review/jev-display-fixes-20260918/t7-*.log`。

## 边界与不做

- 未改 Jev 模型/阈值/提示词预算/验收通过标准；未加执行前约束（直达路径参数由 Jev 从用户文本提取、天然只含要求字段；回退路径无明确判定范围，按票面不强制）。
- 配对窗口归属缝隙记为验收台已知缺口（会放大 deliveryIdentity 假阳性），本轮未修；MiniMax 的格式习惯列为试用观察项，不属产品缺陷。
