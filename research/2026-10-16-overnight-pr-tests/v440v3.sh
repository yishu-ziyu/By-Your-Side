#!/bin/bash
# #440 v3: consequence-based receipt. port 8941 (never 8957). cap 200 s.
cd /workspace/proto-bot/overnight; EXT=$PWD/builds/p440v3; D=:47; PORT=8941
CHK='JSON.stringify([memo.value, document.getElementById("editor").textContent, kind.value])'
r(){ curl -s http://127.0.0.1:$PORT/__reset >/dev/null; node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "v3-$1" --arg u "http://127.0.0.1:$PORT/" --arg p "$2" --arg c "$CHK" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:200,after:[{shot:"receipt",wait:1000,text:".plan-card .plan-receipt-line"},{check:$c,shot:"before-undo",wait:200},{click:".plan-card .plan-undo",shot:"undo",wait:3500,text:".plan-card .plan-receipt-line"},{check:$c,shot:"after-undo",wait:200}]}')" 2>&1 | tail -1 | cut -c1-160; echo "SAVES $1 $(curl -s http://127.0.0.1:$PORT/__saves)"; }
for i in 1 2 3; do r pc$i "新建验收：备注写随手记并回车，正文写好，点刷新，分类选项目，再新建一条笔记，标题写周会纪要，保存。"; done
r nk1 "把备注弄成随手记"
r nk2 "分类换到项目那一项"
r nk3 "正文那块帮我记一句：明天交周报"
r q1 "这个页面上的分类有哪几种？"
echo ALLDONE
