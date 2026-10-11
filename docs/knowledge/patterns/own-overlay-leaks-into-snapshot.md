# 经验：扩展自己挂在页面上的浮层混进了快照

## 现象

同一页、内容没变，连着读两次 AX 快照，结果总差两行：「By Your Side」名牌和「中止」按钮的编号变了。所以「同一页没变就不再带全文」永远判成变了；模型也能在快照里看到、点到自己的「中止」按钮。

## 原因

- 光标层、名牌、中止按钮挂在页面里一个带 `data-sideagent-overlay` 的宿主元素下（封闭 shadow root）。读正文的代码按这个属性跳过它们，但 `Accessibility.getFullAXTree` 不认这个属性，照样把它们放进树里。
- 浮层每次运行重新挂上，节点是新的，编号也是新的。

## 方法

- 取 AX 树前，找出页面上所有带 `data-sideagent-overlay` 的宿主元素的 `backendNodeId`，把以它们为根的子树从节点表里删掉（`extension/src/background/exec/snapshot.ts` 的 `ownOverlayHosts`）。
- 判断「两次读到的一样不一样」之前，先逐行 diff 两次结果，看差在哪里，不要先猜是页面在变。

## 适用条件

扩展在页面里画了东西（光标、标注、确认框），又要拿页面读数做比较、去重或给模型看。另见[核验看不到扩展自己画的东西](host-overlay-invisible-to-verification.md)：那一条是该看到的看不到，这一条是不该看到的被看到了。

## 验证与来源

- [历史只追加](../../evals/20261011-history-prefix.md) R3：去掉过滤时 `history-prefix.mts` b 失败，两次读页只差浮层那两行的编号；加上后通过。
- 未验证：页面自己的元素如果也带这个属性，会被一起跳过；正文读取原来就是这样。
- 2026-10-11，本轮主代理。
