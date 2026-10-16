#!/bin/bash
# #440 v3: consequence-based receipt. port 8941 (never 8957). cap 200 s.
cd /workspace/proto-bot/overnight; EXT=$PWD/builds/p440v6; D=:47; PORT=8941
CHK='JSON.stringify([memo.value, document.getElementById("editor").textContent, kind.value])'
r(){ curl -s http://127.0.0.1:$PORT/__reset >/dev/null; node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "v6-$1" --arg u "http://127.0.0.1:$PORT/" --arg p "$2" --arg c "$CHK" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:200,after:[{shot:"receipt",wait:1000,text:".plan-card .plan-receipt-line"},{check:$c,shot:"before-undo",wait:200},{click:".plan-card .plan-undo",shot:"undo",wait:3500,text:".plan-card .plan-receipt-line, .plan-undo-result"},{check:$c,shot:"after-undo",wait:200,text:".plan-undo-result, .fill-undo-result, .plan-card .plan-receipt-line"}]}')" 2>&1 | tail -1 | cut -c1-160; echo "SAVES $1 $(curl -s http://127.0.0.1:$PORT/__saves)"; }
r pc1 "新建验收：备注写随手记并回车，正文写好，点刷新，分类选项目，再新建一条笔记，标题写周会纪要，保存。"
