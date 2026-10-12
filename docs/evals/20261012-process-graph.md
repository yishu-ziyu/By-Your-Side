# 任务: 并行查找画成分叉，做完折成一行

## 规则
- R1 同一轮同时开多个标签页，过程块出现 B3 扇形，不把它们排成先后队列。
  - 例子(正)：同时开 4 页时出现 4 个标签页方块 — 谁检查：`process-graph.mts` a
- R2 同一轮同时抓多路，过程块出现 B1 竖向分支；5 路长出错开 280±40ms，分叉 450±50ms。
  - 例子(正)：5 路 js 同时开始，第 1 路与第 5 路 animation-delay 差约 280ms — 谁检查：`process-graph.mts` b
- R3 死路写 #304 的人话原因，不写「出错」，不用红色。
  - 例子(正)：两路分别写「接口没回（HTTP 0）」「连不上这个地址」 — 谁检查：`process-graph.mts` c
- R4 汇合后 700ms 开始折，550ms 折完；进行中过程块高度 ≤176px。
  - 例子(正)：回答出来后各组 `data-state=folded`，高度 ≤176 — 谁检查：`process-graph.mts` d

## 还没答上的问题
- 无

## 技术前提
- 前提：A+C 两行已经在，分叉是加在 summary 下面的一层。#304 的 `reason` 已打进本分支（#316 还没合进主干）。小实验：`process-block-record.mts --label=before` 录到现状没有分叉。结果：通过

## 边界与不做
- 单步回合不画分叉；`process-block.mts` 仍应通过。
- 不新做皮肤，只用现有 token 和 `--e-swift`。
