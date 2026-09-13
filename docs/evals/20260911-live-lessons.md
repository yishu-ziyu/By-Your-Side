# 任务: 从第一次 live 失败里抽出下次能过的改法

首轮 150 次（`live-2026-09-11T08-34-18-888Z`）**不重跑、不改门槛**。下面是失败分类和下一轮改什么。

## 情报

约 137 次时：107 过 / 30 败。失败不是一团糊。

1. **页面已经对，交付是空的（约 19 次）**  
   `fill-name` 页面是「林夏」、`count-list` 页面是 5、读取类 snapshot 后主标题已在页上。`deliveryText=""`。  
   原因：`agent_end` 后补交付是 `void fulfillOwedDelivery`，评测在补交付完成前就采样并 dispose。产品上侧栏/语音也会抢在 finding 前看到 idle。  
   **下次：** 空闲之后再等最多 12s 的 finding；补交付仍不许调写工具。

2. **原生 `<select>` 五次全败（`select-city` 0/5）**  
   模型去 click/fill 下拉，headless 没有系统选择器；随后 snapshot 连失败三次。  
   **下次：** `fill` 按可见文案或 value 选 option，不要靠点击弹出菜单。  
   第二轮 replica 1 仍去 click（工具说明还只写了 input/textarea）。已把 fill 说明改成包含 select；不重跑 replica 1。

3. **工具连失败三次停手（约 11 次）**  
   snapshot/fill/click/read_element 被同一错误卡住。部分是 select 的后续；部分是共享页 `page_operation` 用在单人页。  
   **下次：** 单人页不要走协作者专用 `page_operation`；select 修好后应少很多。

4. **关键字核验不是这批主因**  
   拆开后「交付有字但对不上关键字」= 0。先前以为「开」太严，实际是交付根本没到。

## 不做

- 不把本轮 150 的失败改成通过。
- 不删失败样本。
- 不关交付断言假装绿。

## 第二轮结果（`live-2026-09-11T09-14-42-075Z`）

139/150 = 92.7%。读取 50/50，多步 47/50，表单 42/50。空交付 0。`select-city` 3/5。

剩下 11 次全是页面失败：多数先误用 `page_operation`（单人页），再 snapshot/read_element 连失败三次停手；`three-pages` 两次停在第 2 页空态 click 失败。`select-city` replica 1/4 仍去 click。

下一刀：单人页禁止把 `page_operation` 当 fill；snapshot 连续失败不要把整轮判死前先换工作页；翻页按钮在空页仍要点得着。不覆盖第一、二轮样本。

## 第三轮改法（产品，不洗账）

第二轮 11 次的真实路径不是「snapshot 自己坏了」，是账本把一次被拒的写入记成 `unknown` 之后，连观察工具都抛同一句「请先用 snapshot」。`three-pages` 另是同一「下一页」第二次被「已有成功回执」拦住。

第三轮 `10-11-47` **LOCKED**：145/150 = 96.7%，表单 96%，多步 94%，读取 100%。门槛过了。

剩余 5 次情报（不洗账）：过期或格式错误的 ref 点击/填写仍被记成 `unknown`（文案是「操作未执行」），观察能跑但换新 ref 写入仍被闸门拦住。`fill-twelve` 一轮超时空交付、`pause-then-comment` 是 `browser_run` 没 await，属模型面。后续改：动作前拒绝带结构化 `not_executed`，live 桥接回传 `executionFact`。
