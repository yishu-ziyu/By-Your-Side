#!/bin/bash
EXT=${EXT:-/workspace/proto-bot/overnight/builds/plan-receipt-morph}; D=${D:-:42}; P=${P:-p440}
VALS='JSON.stringify([...document.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox]),textarea,select")].map(e=>e.value).filter(Boolean))'
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "$P-$1" --arg u "$2" --arg p "$3" --arg v "$VALS" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:180,midShot:".plan-card",check:$v,after:[{shot:"receipt",wait:500,text:".plan-card"},{click:".plan-card .plan-details",shot:"details",wait:1200},{click:".plan-card .plan-undo",shot:"after-undo",wait:2500,text:".plan-card"},{shot:"final",wait:300,check:$v}]}')" 2>&1 | tail -1; }
r 01 http://127.0.0.1:8931/signup "帮我把报名表填上：姓名王五，手机13700000000，备注带水。不要提交。"
r 02 https://httpbin.org/forms/post "帮我把这个订餐表填好：名字 Alice，电话 555-1234，邮箱 alice@example.com，送达说明写放门口。不要提交。"
r 03 https://www.selenium.dev/selenium/web/web-form.html "把这个表单的文本框填 hello，密码框填 test123，文本区写 这是一段测试。不要提交。"
