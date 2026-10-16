EXT=/workspace/proto-bot/overnight/builds/p439v2; D=:42
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "p439v2-$1" --arg u "$2" --arg p "$3" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:150,after:[{text:".msg.assistant .page-ref",shot:"refs",wait:300},{text:".msg.assistant strong",shot:"bold",wait:300},{click:".msg.assistant .page-ref",shot:"after-ref-click",wait:2500}]}')" 2>&1 | tail -1; }
r hn https://news.ycombinator.com/ "我想登录这个网站，点哪里？"
#r bold https://news.ycombinator.com/ "用一两句话介绍这个网站是做什么的。请用粗体强调两个关键词，例如**技术新闻**、**社区讨论**，不需要指出页面按钮。"
