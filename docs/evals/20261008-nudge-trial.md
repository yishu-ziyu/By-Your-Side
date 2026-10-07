# 任务: 主动卡用真实模型挂着试，事后能看到每次判断出了什么卡、为什么没出

来由：YIS-106 只用脚本模型验过。用户 10-08 决定先用真实模型挂着试一阵，再决定要不要扩大卡能提的事。

## 规则
- R1 每次判断在本机诊断记录里留一行 `nudge_verdict`：哪一页、出没出卡、卡写了什么；没出卡时分清「模型说不建议」和「想建议但没过核对」（后者带模型原话，截 400 字）。
  - 例子(正)：三页各出一张卡，设置页导出的诊断记录里有三行 verdict=offer，动词、句子、对象名都在 — 谁检查：`npx tsx scripts/acceptance/real-path/proactive-card.mts --headless`
- R2 有一个能重跑的批量试跑：真网页 + 仿造私人页面 + 「先看 A 再看 B」，逐页交给真实模型，写出每页的结论和模型原话。
  - 例子(正)：`NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/nudge-trial/trial.mts --headless` 写出 `out/probes/nudge-trial/result.json` — 谁检查：命令

## 技术前提
- 前提：Node 里能用订阅凭据直接调 `judgeNudge`。 小实验：沿用 `scripts/probes/route-check/route-check.mts` 的做法。 结果：通过。

## 实测（2026-10-08，openai-codex/gpt-6-luna）
- 25 个场景里 21 个做了判断（4 个页面靠脚本加载、正文不到 100 字或打不开）。模型想出卡 6 次，过核对 2 次，都是「记下」。
- 想出的 6 张里 4 张被字数上限拦下：句子上限 20 字，带英文型号的句子（「AirPods Pro 3 与 AirPods 5」25 字）就超；引文上限 60 字也拦了两次。YIS-106 让句子写进具体名字和数字，句子更长，被拦更多。
- 仿造的酒店订单、机票只提「记下」，水费短信、会议邀请不出卡；从不提申请、付、值机、回复：判断规则只允许建议读、比、记、翻译。
- 首页、搜索页、文档页都不出卡。每次判断 2.5–11 秒。
- 正文取法照内容脚本（article → main → body），但页面只等 5 秒；真插件要停留 15 秒以上，靠脚本加载的页取到的正文可能更多。

## 边界与不做
- 不改判断规则和字数上限：先给用户看结果再定。
