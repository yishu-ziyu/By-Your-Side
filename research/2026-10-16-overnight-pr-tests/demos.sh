#!/bin/bash
EXT=/workspace/proto-bot/overnight/builds/p290; D=:41
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "demo-$1" --arg u "$2" --arg p "$3" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:200,record:true}')" 2>&1 | tail -1; cp runs/demo-$1/video.mp4 videos/demo-$1.mp4 2>/dev/null; }
r 1-idea-draft https://www.selenium.dev/selenium/web/web-form.html "我有个想法：公司每周五下午搞一次 30 分钟的读书会。帮我写成一段格式完整的提案草稿（目的、时间、形式、第一期书目），填进这个表单的 Textarea，Text input 填标题。不要提交。"
r 2-compare-books https://books.toscrape.com/ "比较这页前 6 本书的价格和星级，列个表，告诉我哪本最值得买。"
r 3-summarize-mdn https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API "用中文总结这页的要点：Fetch API 是什么、核心接口有哪些、和 XMLHttpRequest 比有什么不同。"
r 4-fill-order https://httpbin.org/forms/post "帮我填这个订餐表：名字 Alice，电话 555-1234，邮箱 alice@example.com，选大号披萨，加培根和蘑菇，送达时间 19:30，备注放门口。不要提交。"
