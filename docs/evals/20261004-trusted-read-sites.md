# 任务: 用户信任过的网站上，读页面与打开网页不再逐次批准；写入照旧每次批准

起因：[北极星基线](20261004-north-star-cross-site.md) 查一个词要批准 13 次，其中 11 次是只看不动的打开与读取。用户 10-04 选定“按网站信任”（不选“只批写入”“整个计划批一次”），范围按**整个域名**；代理补充用公共后缀表计算域名，防止 github.io 这类人人可建子站的地方被整体信任。

## 规则

- R1 只看不动的动作在受信任域名上不弹卡：读取（snapshot、read_element、read_elements、screenshot）按当前页所在域名判断；打开（tabs open、navigate）按目标网址域名判断。
  - 例子(正)：在信任了 wikipedia.org 时，当助手打开 zh.wikipedia.org 的词条并读取，那么不弹确认卡。 — 谁检查：`north-star-research.mts` 新场景，确认卡计数
  - 例子(反)：在只信任了 wikipedia.org 时，当网页里的指令让助手打开 attacker.test，那么照常弹卡。 — 谁检查：同上，注入场景
  - 例子(反)：在信任了 alice.github.io 时，当助手读 bob.github.io，那么照常弹卡（github.io 在公共后缀表上）。 — 谁检查：域名计算的单元检查
- R2 写入与其他有副作用的动作不受信任影响，照旧逐次批准：点击、填写、选择、按键、页面脚本、网络请求、切换/关闭标签页、处理弹窗等。
  - 例子(正)：在信任了 flomo 的域名时，当助手填写并保存笔记，那么填写和保存各弹一次卡。 — 谁检查：确认卡计数（写 = 2）
- R3 信任由用户在读取/打开卡上点“以后这个网站不再问”授予，可在设置里看到并移除；移除后立即恢复逐次批准。
  - 例子(正)：移除 wikipedia.org 后，下一次读取维基照常弹卡。 — 谁检查：验收场景
  - 例子(反)：网页内容、模型参数、聊天里的“信任它”都不能授予信任。 — 谁检查：只有侧栏卡片按钮与设置页写入信任列表（代码核对＋验收）
- R4 读取在执行前后核对页面身份：执行前页面已不在受信任域名、或读取期间页面换了文档，结果丢弃并按未执行处理，不把别的网站内容交给模型。 — 谁检查：单元/定点检查

## 还没答上的问题

- 无（范围、授予方式、撤销位置已由用户或默认定下；设置页的具体样式按现有设置页沿用）。

## 技术前提

- 前提：tldts 能把 zh.wikipedia.org、en.wikipedia.org 归为 wikipedia.org，把 alice.github.io、bob.github.io 分成两个域名，并能打进扩展包。小实验：`scripts/probes/trusted-domain-psl.mts` 结果：通过（见进展）。

## 实施前列出的失败方式

- F1 信任范围算错：把公共后缀（github.io、co.uk）当成可信任的整体。
- F2 读取时页面已跳到别的网站，读到的内容仍交给模型。
- F3 写入类动作误入免批名单（例如把 js、fetch、click 当成“读”）。
- F4 网页或模型能写入信任列表。
- F5 撤销后旧信任仍在缓存里生效。
- F6 打开受信任网站时网址查询串夹带用户数据外传：该网站本就是用户选定的网站，接受；不受信任网站仍拦（已知边界，写进文档）。

## 边界与不做

- 不改写入类动作的逐次批准、不改页面状态绑定与作废规则。
- 不做“整个计划批一次”。
- 不迁移已有会话里的旧授权（之前没有信任列表）。

## 进展（10-04）

- 技术前提通过：`scripts/probes/trusted-domain-psl.mts`（zh/en.wikipedia.org → wikipedia.org；alice/bob.github.io 分开；bbc.co.uk；IP 为 null），tldts 7.4.16 可打进扩展包（隔离构建含 `trustedReadSites`）。
- 实现：`shared/trusted-sites.ts`（域名与可免动作）、后台执行前判断与读后 documentId 复核（`extension/src/background/index.ts`）、`ActivationConsent` 仅在批准真正成功且选了信任时写入卡上的后台域名、侧栏卡第三个按钮、设置页“信任的网站”列表与移除。在当前页跳转（navigate）不在免批范围：离开页面可能丢掉已填内容。
- 单元检查：`extension/test/trusted-read-sites.test.ts` 11 项通过；故意改成“拒绝也写入信任”和“不用私有后缀”各有用例失败。类型、架构边界、文档同步、lint 通过。
- 全量单元：负载 99 时一批 agent 侧定时测试时有时无地失败（同一代码连跑 6 次 0/0/0/1/1/0）；负载降到 4 后全量 298 个文件 3077 项通过。
- 真实路径验收（Codex，Linear YIS-31，提交 `01bf92b`；Claude 复跑与反例核对后合入）：`north-star-research.mts --headless --scripted` 产物 `out/acceptance/real-path/2026-10-04T09-37-41-486Z-north-star/` N1–N6 全部 PASS。N4：第一个词点信任后，第二个词只弹填写与保存 2 张卡、读/开卡 0 张，存储里恰是点过的域名（两个词共 8 张卡，修改前基线一个词 13 张）。N5：预置信任四站后，网页诱导打开 attacker.test 仍弹卡，拒绝后该站 0 请求。N6：设置页移除 wiki.test 后再读维基弹卡。Claude 把 N5 的 attacker 请求改成 1 条重判，FAIL、退出 1。界面截图：`N4/consent-1-snapshot.png`（三个按钮的卡）、`N6/settings-before-remove.png`、`N6/settings-after-remove.png`。
- 已知小问题（未改）：读取卡沿用写入卡的通用说明“可能提交、发送或自动保存”，对读取不准确。
- 未完成：装进日常扩展（等用户看过界面）。
