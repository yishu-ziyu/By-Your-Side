import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dir = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();

const report = `<html><body style="font-family: 'PingFang SC', sans-serif">
<h1>年度合同摘要</h1><p>甲方：远山科技有限公司。乙方：青禾设计工作室。</p>
<div style="page-break-after: always"></div>
<h2>第二部分 付款</h2><p>首付款 30%，验收后付清。</p>
<div style="page-break-after: always"></div>
<h2>第三部分 交付</h2><p>交付日期：2025 年 6 月 30 日。逾期每天扣合同金额的 0.5%。</p>
</body></html>`;
await page.setContent(report);
await writeFile(join(dir, "contract.pdf"), await page.pdf({ format: "A4" }));

const scan = (await readFile(join(dir, "scan-page.png"))).toString("base64");
await page.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${scan}" style="display:block;width:100%;height:100vh;object-fit:contain"></body></html>`);
await writeFile(join(dir, "receipt-scan.pdf"), await page.pdf({ format: "A4", printBackground: true }));
await page.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${scan}" style="display:block;width:100%;height:100vh;object-fit:contain"><div style="page-break-before:always;height:10px"></div></body></html>`);
await writeFile(join(dir, "scan-with-blank.pdf"), await page.pdf({ format: "A4", printBackground: true }));
await browser.close();

await writeFile(join(dir, "memo.html"), "<html><head><meta charset=\"utf-8\"><title>备忘录</title></head><body><h2>会议备忘</h2><p>下次评审定在周四下午三点。</p><ul><li>带上原型</li></ul></body></html>");
execFileSync("textutil", ["-convert", "docx", "-output", join(dir, "memo-textutil.docx"), join(dir, "memo.html")]);
console.log("ok");
