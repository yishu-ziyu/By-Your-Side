# usage: EXT=... D=... P=... bash pc.sh
for i in 1 2 3 4 5; do curl -s http://127.0.0.1:8941/__reset >/dev/null
node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "$P-$i" --arg p "新建验收：备注写随手记并回车，正文写好，点刷新，分类选项目，再新建一条笔记，标题写周会纪要，保存。" '{ext:$ext,display:$d,tag:$t,url:"http://127.0.0.1:8941/",prompt:$p,maxSec:300}')" 2>&1 | tail -1 | cut -c1-200
echo "SAVES $i $(curl -s http://127.0.0.1:8941/__saves)"; done
