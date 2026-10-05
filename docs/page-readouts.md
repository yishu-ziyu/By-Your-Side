# 页面读数：截断文字与输入范围

[协议](protocol.md) · [验收记录](evals/20261002-tier1-product-gaps.md)

页面读数指快照、读元素和填写回执交给模型的内容。规则写在 [shared/page-readout.ts](../shared/page-readout.ts)，各读取入口按同一规则实现。

## 截断文字给出完整值

页面把长文字截成省略号显示时，读数在原文字后附上完整值。

- 完整值只取元素自己的 title、aria 名字或描述，而且只在这个值以截断前缀开头、比前缀长时采用。不猜 `data-*`、相邻文字或其他属性。

| 页面 | 读数 |
|---|---|
| `<a title="Asus ROG Strix GL702VM-GC146T">Asus ROG Strix...</a>` | `link "Asus ROG Strix..." full="Asus ROG Strix GL702VM-GC146T"` |
| `<span title="Opens in a new window">Read more...</span>` | `text: Read more...`（title 不以「Read more」开头，不附） |
| CSS `text-overflow: ellipsis` 截断的链接 | DOM 文字本身完整，读数照常给全文，不需要额外规则 |
| `<a aria-label="HP 250 G6 Silver">HP 250...</a>` | 无障碍名字已是完整的 aria-label，不重复附 |

## 范围输入框带允许范围

原生时间、日期、数字和滑块输入框的读数带上页面写的最小值、最大值和步长。因为无障碍树不提供时间、日期框的这些属性和当前值，所以全页快照按节点补读 DOM。读不到时，快照照常输出，只缺范围。

- 填写越界时照常写入，但回执说明页面不接受这个值及允许范围，不报成单纯成功。越界时间是写入后警告，不是拒绝写入。
- 判定完全以浏览器自己的 `validity` 为准，不自行比较时间或数字。
- 时间框格式无效（如 `9:30pm`）时不执行，保留原值。空串仍可清空。
- 时间框的时、分子框按所属的原生时间框填写完整时间；网页刷新子框后，应重新快照获取 ref。

验收入口见[验收入口](testing/acceptance.md)；`--live` 另读 webscraper 测试站最后一页与 httpbin 表单（只填不提交）。
