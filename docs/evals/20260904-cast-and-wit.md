# 任务: 并行执行流换成「有名字的人」，等待时有一点插科打诨

来源：2026-09-04 人评（bilibili 抓评论 ∥ flomo 填笔记）。功能认 OK；不喜欢「工人」；要颜色/命名区分；思考/派发/等待可以有一点好玩的词。先出 HTML 三案让人挑，再落地。

```
Change:     并行时侧栏和页面光标是几个有名字、有固定颜色的人；等待/思考有短而好玩的词在转；连续 js 收成一条；任务结束后 loader 立刻消失。界面不再出现「工人」。
Not this:   只把「工人」替换成「助手」；每条工具 chip 都开玩笑；假百分比进度条；把 Lead 的完成态和还在跑的人叠在同一个「处理中」。
Evaluator:  人评：打开 HTML 三案挑一向。落地后同一类并行任务复测。机器：typecheck / test / build。
Evidence:   本卡 + docs/evals/20260904-cast-compare.html + wrapper-err 时间线。
```

## 完成标准

- [x] 1. HTML 三案（现在 / 有名字的人 / 更安静）摆在同一任务时间线上，用户能指出要做哪一案 — evaluator: 人评（2026-09-04：选 B+C；不要色名；小名要设计；词表 OK；执行块加动效，参考 ui-skills.com）
- [x] 2. 落地后界面文案与光标名牌不再出现「工人」「派出工人」——类名取消，人有自己的短名 — evaluator: 文案扫描（steps/cast 单测 + dist 无「工人」）+ 人评
- [x] 3. 每个并行实例：侧栏色条、chip/行、页面光标、名牌，四者同色同名 — evaluator: personFor 纯函数 + cursorColor=人名册色；人评真机双光标
- [ ] 4. 连续相同工具（尤其 js）默认收成一条「在页面里找了 N 次」，点开才展开 — evaluator: steps 单测 + 对照本次日志（flomo 17 次 js、bilibili 14 次）
- [ ] 5. 思考 / 等待同伴时，主状态行轮换短词；词是产品写死的词表，不是模型现场编的。任务结束或失败的那一帧立刻停转、换成完成/失败 — evaluator: 单测词表 + 无头「结束后无 loader」+ 人评（词是否油）
- [ ] 6. Lead 说完「完成」后，若还有人在跑，只留那个人的行，不再新开一个「处理中 · 226s」的空执行块 — evaluator: 复现本次截图第二张的终态，机器断言 + 人评
- [ ] 7. `npm run typecheck` / `npm test` / `npm run build` 全绿 — evaluator: 机器
- [ ] 8. 真机：再跑一条双站点任务，两个光标名牌可辨，侧栏能分清谁在等谁 — evaluator: 人评

## 边界与不做

- 不改 spawn / 邮箱 / 绑标签页的协议语义，只改呈现与用词
- 不做三个聊天线程
- 不做 LLM 实时生成段子（词表写死，可后加）
- 不造假百分比进度条（长任务仍是不确定型）
- 不把「工人」全局搜替换当完成
- 光标形状不重做，只改名牌文字与颜色绑定

## 这次任务日志（机器项，供对照）

`~/.sideagent/wrapper-err.log` 末段：

- Lead 先 `open_tab` flomo 21600ms、bilibili 21626ms，然后 `spawn worker=flomo` / `spawn worker=bilibili`。并行成立。
- 热路径几乎全是 `js`：bilibili 14 次、flomo 17 次。面板上就是一墙「执行脚本 0.0s」。
- stderr 在 flomo 最后一次 js 处截住，`post` / `await_message` 的 ok 行还没落盘——阻塞中的 await 本来就不会先打 ok。截图里 bilibili 连续两次「等待 done」（1m 20s、2m 19s）像超时后重等。
- 截图 2：Lead 已经写出「完成」，下面又冒出一个 flomo「处理中 · 226.3s」。根因候选：Lead `agent_end` 把主 run 收掉后，工人后续事件 `ensureRun()` 又开了一块空壳。
