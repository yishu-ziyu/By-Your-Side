# 文件卡片与截图

[协议](protocol.md) · [组合执行里的存文件](browser-program.md#存文件) · [使用说明](guides/usage.md#生成文件)

## 文本文件

Lead 工具 `artifacts` 为用户写文本文件（csv、md、txt、json、html、svg、js、css），命令沿用 Pi web-ui 的约定：`create`（同名已存在则失败）、`update`（`old_str` → `new_str`，找不到时返回全文）、`rewrite`、`get`、`delete`。文件只存在本会话内存，单个上限 256 000 字符，文件名只许一层并带扩展名。每次保存发 `agent_event{kind:"artifact",action:"saved",filename,content}`，删除发 `action:"deleted"`；侧栏画成带「打开」「下载」按钮的卡片，回合结束时挪到回答下面，CSV 下载时加 BOM。「打开」在新标签页显示，网页跑在沙箱页、碰不到 `chrome.*` 与扩展存储（[查看页](../extension/src/sidepanel/artifact-viewer-page.ts)）。事件随侧栏历史回放；宿主重启后模型不再能 `get` 旧文件。`browser_run` 程序里的 `browser.saveFile` 写进同一个文件区（同样规则、同名覆盖、同一条 `artifact` 事件），程序只拿到长度回执，正文不进模型上下文（[细节](browser-program.md#存文件)）。

## 截图：哪些给用户看

截图默认只给模型自己看：`screenshot` 的图只进模型上下文，侧栏只在执行过程里记一步「截图」；`browser_run` 里的 `browser.screenshot()` 和工人会话的截图同样不给用户。只有模型调用 `screenshot` 时带 `forUser:true`（用户要的就是这张图，如「把这页截个图给我」）才交给用户：宿主把这张 PNG 存进同一个文件区，文件名 `截图-<本地时间>.png`，发 `artifact{action:"saved",encoding:"base64",content:<PNG 的 base64>}`；侧栏卡片上方直接显示图，点图或「打开」在查看页看大图，「下载」得到原始 PNG。`forUser` 不传给扩展的截图 RPC；会话没有文件区时工具结果明说「没给到用户」。图片文件不能用 `artifacts` 的 get/update/rewrite 读改，只能删；单张上限 8 000 000 个 base64 字符。验收：[标准 1](evals/20261002-tier1-product-gaps.md)。
