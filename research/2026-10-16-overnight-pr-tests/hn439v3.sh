#!/bin/bash
EXT=/workspace/proto-bot/overnight/builds/p439v3; D=:42
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "p439v3-$1" --arg u "$2" --arg p "$3" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:150,after:[{text:".msg.assistant .page-ref",shot:"refs",wait:300},{click:".msg.assistant .page-ref",shot:"after-ref-click",wait:2500}]}')" 2>&1 | tail -1; }
r ${TAGP}01 https://github.com/yishu-ziyu/By-Your-Side "我想把这个仓库的代码下载下来，该点页面上哪个按钮？"
r ${TAGP}02 https://en.wikipedia.org/wiki/Chrome_extension "这个页面怎么切换成中文？该点哪里？"
r ${TAGP}03 https://www.python.org/ "我想下载 Python，应该点页面上的哪个按钮？"
r ${TAGP}04 https://news.ycombinator.com/ "我想登录这个网站，点哪里？"
r ${TAGP}05 https://developer.mozilla.org/en-US/ "这个页面上怎么搜索文档？"
