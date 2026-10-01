# 页面读数：截断文字与输入范围

[协议](protocol.md) · [验收记录](evals/20261002-tier1-product-gaps.md)

页面读数指 `snapshot`（无障碍树全页与 DOM 视口两种）、`read_element` 和 `fill` 回执交给模型的内容。下面两条规则写在 [shared/page-readout.ts](../shared/page-readout.ts)，各读取入口按同一规则实现。

## 截断文字给出完整值

页面把长文字截成省略号显示时，读数在原文字后附上 `full="完整值"`（`read_element` 为 `fullText` 字段）。

- 何时算截断：显示文字（合并空白后）以 `…` 或 `...` 结尾，去掉省略号后至少 3 个字符。
- 完整值从哪来：只看元素自己的 `title`、`aria-label`、`aria-description`，依次取第一个满足条件的；无障碍树里对应节点的 description（Chrome 把未用作名字的 title 放在这里），纯文字行另看所在父元素的 description。不猜 `data-*`、相邻文字或其他属性。
- 什么算完整：候选值以截断前缀开头（不分大小写），且比前缀长。

| 页面 | 读数 |
|---|---|
| `<a title="Asus ROG Strix GL702VM-GC146T">Asus ROG Strix...</a>` | `link "Asus ROG Strix..." full="Asus ROG Strix GL702VM-GC146T"` |
| `<span title="Opens in a new window">Read more...</span>` | `text: Read more...`（title 不以「Read more」开头，不附） |
| CSS `text-overflow: ellipsis` 截断的链接 | DOM 文字本身完整，读数照常给全文，不需要额外规则 |
| `<a aria-label="HP 250 G6 Silver">HP 250...</a>` | 无障碍名字已是完整的 aria-label，不重复附 |

## 范围输入框带允许范围

原生 `time`、`date`、`datetime-local`、`month`、`week`、`number`、`range` 输入框的读数带上 `type` 与页面写的 `min`、`max`、`step`（没写的不出现）。无障碍树不提供时间、日期框的这些属性和当前值，全页快照按节点补读 DOM（每次最多 40 个，读不到时快照照常输出、只缺范围）。

- 快照：`InputTime "Preferred delivery time:" type=time min="11:00" max="21:00" step="900"`；有值时带 `value=`，浏览器判定越界时带 `invalid=rangeUnderflow|rangeOverflow|stepMismatch`。
- `read_element`：`inputRange{type,min?,max?,step?,problem?}`；只读状态属性时也保留这一项。
- `fill`：照常写入；写入后浏览器的 `validity` 报 `rangeUnderflow`、`rangeOverflow` 或 `stepMismatch` 时，回执带 `rangeIssue{type,min,max,step,value,problem,message}`，模型看到的文字为「Filled …, but the value is not accepted by the page. Out of range: "21:30" is above the page's maximum 21:00. Allowed: 11:00–21:00, step 900 s. …」，不报成单纯成功。`browser_run` 里的 `browser.fill` 返回同一份数据。

判定完全以浏览器自己的 `validity` 为准，不自行比较时间或数字。格式不合法、被浏览器清空的值（例如给时间框填 `9:30pm`）不在这条规则内。

## 验收

`npx tsx scripts/acceptance/page-readouts.mts --headless [--live]`：隔离无头 Chrome 加载当前源码构建的扩展，本机样例页覆盖上面各种形态；`--live` 另读 webscraper 测试站最后一页与 httpbin 表单（只填不提交）。产物在 `out/acceptance/page-readouts-<时间>/`。
