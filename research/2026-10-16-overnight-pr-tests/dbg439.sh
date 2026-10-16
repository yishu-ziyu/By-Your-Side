EXT=/workspace/proto-bot/overnight/builds/p439dbg; D=:42
r(){ node run-task-dbg.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "p439dbg-$1" --arg u "$2" --arg p "$3" '{dbg:true,ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:150}')" 2>&1 | tail -1 | cut -c1-150; }
r 01 https://github.com/yishu-ziyu/By-Your-Side "我想把这个仓库的代码下载下来，该点页面上哪个按钮？"
r 02 https://en.wikipedia.org/wiki/Chrome_extension "这个页面怎么切换成中文？该点哪里？"
r 05 https://developer.mozilla.org/en-US/ "这个页面上怎么搜索文档？"
