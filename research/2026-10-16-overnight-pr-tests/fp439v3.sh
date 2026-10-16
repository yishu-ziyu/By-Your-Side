EXT=/workspace/proto-bot/overnight/builds/p439v3; D=:41
r(){ node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "p439v3-$1" --arg u "$2" --arg p "$3" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:150,after:[{text:".msg.assistant .page-ref",shot:"refs",wait:300},{text:".msg.assistant strong",shot:"bold",wait:300}]}')" 2>&1 | tail -1 | cut -c1-120; }
r fp1 https://news.ycombinator.com/ "用一两句话介绍这个网站是做什么的。请用粗体强调两个关键词，例如**技术新闻**、**社区讨论**，不需要指出页面按钮。"
r fp2 https://github.com/yishu-ziyu/By-Your-Side "这个仓库是做什么的？用两三句话说，重点词加粗。"
r fp3 https://developer.mozilla.org/en-US/ "MDN 是什么网站？简单说说，可以用引号举例它覆盖的技术，比如 \"HTML\"、\"CSS\"。"
r fp4 https://en.wikipedia.org/wiki/Chrome_extension "这篇文章主要讲什么？两句话。"
