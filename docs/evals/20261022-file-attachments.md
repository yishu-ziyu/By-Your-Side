# 任务：在侧栏附上文件，助手读懂内容再回答

## 规则

- R1 附上 PDF、Word（.docx）、Excel（.xlsx）、PPT（.pptx）、CSV、文本和代码文件时，每个文件一张卡，写着格式和页数、表数或幻灯片数。读不了的格式（旧版 .doc/.xls/.ppt、Pages、压缩包）不附上，并一句话说明怎么办。代理检查：`file-attachments.mts` 的 a 项和截图。
- R2 助手收到每个文件的开头，内容包在不可信边界里；长文件写明还剩多少，助手用 `read_attachment` 按位置或关键词读后面。Excel 写出行号、日期、隐藏表；PPT 写出备注；PDF 标出页码；GBK 编码的 CSV 不乱码。代理检查：`file-attachments.mts` 的 b、c 项。
- R3 扫描件（PDF 没有文字层）的页面画成图交给收图的模型，空白页不发；当前模型不收图时，照实告诉模型看不到，不让它假装读过。代理检查：b 项（脚本模型只收文字）和 `file-attachments-real.mts`（MiniMax M3.1 收图）。
- R4 文件还在读时按发送，读完自动发出，不丢文件；已发出的消息里显示文件卡，多于 5 个时收起其余。代理检查：d 项。

例子（反）：让文件文字不接进消息，`file-attachments.mts` 的 b、c、d 共 5 项失败。

## 还没答上的问题

无。

## 技术前提

- 解析全在侧栏本机完成，文件不发给第三方服务：PDF 用扩展已有的 pdf.js（在它自己的 Worker 里跑），Office 文件用浏览器自带的 `DecompressionStream` 解 zip、`DOMParser` 读 XML，不新增依赖。解析代码单独打包成 `file-read.js`，第一次附上文件时才加载。
- 测试文件由 `scripts/acceptance/fixtures/files/make_office.py`（python-docx、openpyxl、python-pptx）和 `make-files.mts`（Chrome 打印 PDF、macOS textutil 写 Word）生成，覆盖两种 Word 写法。

## 边界与不做

- 单个文件最多 50 MB；抽出的文字最多 40 万字，超过截断并告诉助手。一条消息最多 16 个附件。
- 原文件不超过 5 MB 时随附件留着，助手可以用 `upload_file` 原样传到网页上；更大的只留文字。
- 不做：旧版二进制 Office 格式、加密 PDF（提示先去掉密码）、图片里的文字识别（交给收图的模型自己看）、Excel 图表和图片、Word 里嵌入的图片。

## 当前证据

- 隔离 Chrome、真实扩展、脚本模型：`file-attachments.mts` 11 项全部通过。
- 隔离 Chrome、真实扩展、MiniMax M3.1：`file-attachments-real.mts` 5 项全部答对。答对的内容包括只在扫描图里的收据编号，以及只能用 `read_attachment` 找到的暗号；回答标出了文件、页、表和行。
- 日常 Chrome 里的真人使用尚待验证。
