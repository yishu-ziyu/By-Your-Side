#!/bin/bash
B=$1; D=$2; EXT=/workspace/proto-bot/overnight/builds/$B; U=http://127.0.0.1:8931
for run in 1 2; do
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "m-$B-$1-$run" --arg u "$2" --arg p "$3" --arg c "$4" --arg k "$5" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:150,check:$k} + (if $c=="" then {} else {confirm:$c} end)')" 2>&1 | tail -1; }
r T1 $U/table "这个表里 Q3 合计是多少？哪个产品 Q2 到 Q3 增长最多？" "" "1"
r T2 $U/signup "帮我把报名表填上：姓名张三，手机13800000000，人数2，备注带伞。不要提交。" "" 'JSON.stringify([...document.querySelectorAll("input,select,textarea")].map(e=>e.value))'
r T3 https://news.ycombinator.com/ "这个页面排名前3的帖子标题是什么？" "" '[...document.querySelectorAll(".titleline > a")].slice(0,3).map(a=>a.textContent).join(" || ")'
r T4 $U/chat "回复小王：评审明天下午两点开始，然后发送。" decline "1"
r T5 $U/search "在站内搜索“部署”。" "" 'document.querySelector("#status").textContent + " | " + document.querySelector("#q").value'
done
