# 任务: 执行块里人和工具的布局、比例

来源：2026-09-04 人评截图。人已经有了；各组件挤在一起，chip 跟人一个量级。

```
Change:     扫一眼先看到 Kim/Gus；工具 chip 从属于那个人。组与组之间比组内疏。
Not this:   只把名字字号加大；只加一层边框；假进度。
Evaluator:  人评同一条并行任务的侧栏。机器：typecheck / test / build。
Evidence:   本卡 + 改过的 run-steps / worker-lane CSS 与 summary 结构。
```

## 这一屏要判断的事

1. 人是不是第一眼。
2. chip 是不是挂在那个人下面（缩进对齐名字）。
3. 两个之间的空，是不是大于一个人内部的空。

## 对照过的 Will's S

- Hierarchy / Size isn’t everything：名字加粗，链和 chip 用灰，不靠撑字号。
- Emphasize by de-emphasizing：人的 chip 更小、去描边、底更淡。
- Avoid ambiguous spacing：组间 12、组内 8/4。
- Spacing system：4 / 8 / 12 / 16 / 32。
- Start with too much white space：人用分组底，不要再把所有东西贴成一墙。

## 完成标准

- [ ] 1. 人的行：32 头像 + 名在上、步骤链在下、等待句在右 — evaluator: 人评
- [ ] 2. 工具 chip 缩进到名字列，比 Lead 的 chip 更小更淡 — evaluator: 人评
- [ ] 3. typecheck / test / build 绿 — evaluator: 机器

## 边界与不做

- 不改名册、不改协议、不收 js 墙（另卡）
- 不把思考块拿掉
