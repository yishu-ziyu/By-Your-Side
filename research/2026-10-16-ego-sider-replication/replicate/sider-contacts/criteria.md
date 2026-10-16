# sider-contacts — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Company Contact Collector: emails, phones and addresses from contact pages into a spreadsheet"

Fixture: http://127.0.0.1:8995/co/acme/contact (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 收集 Acme、Borealis、Cirrus 三家公司联系页上的业务邮箱、电话和地址，导出成电子表格文件给我。

Pass criterion / expected:
Acme sales@acmerobotics.example +86 21 5555 0101 88 Zhangjiang Rd…; Borealis hello@borealis.example +86 10 6666 0202 1 Zhongguancun St…; Cirrus contact@cirrus.example +86 755 7777 0303 200 Keyuan Rd…. Distractors: careers/press emails and fax numbers. Spreadsheet file required; correct data without file = 卡在缺能力 (file export).

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
