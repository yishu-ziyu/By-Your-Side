R(){ node run-rec.mjs "$1" 2>&1 | tail -1 | cut -c1-160; }
curl -s http://127.0.0.1:8931/__reset >/dev/null
R "$(jq -nc --arg ext $PWD/builds/p290v2 '{ext:$ext,display:":43",tag:"v2-a-send-confirm",url:"http://127.0.0.1:8931/chatlong",prompt:"回复小王：下周二上午十点评审，请提前准备演示。写好后发送。",maxSec:150,record:true,confirm:"send",after:[{shot:"end",wait:2500}]}')"
echo "POSTS $(curl -s http://127.0.0.1:8931/__posts)"
R "$(jq -nc --arg ext $PWD/builds/p439main '{ext:$ext,display:":43",tag:"v2-b-page-ref",url:"https://www.python.org/",prompt:"我想下载 Python，应该点页面上的哪个按钮？",maxSec:120,record:true,after:[{shot:"pre",wait:1500},{click:".msg.assistant .page-ref",shot:"ref",wait:4000}]}')"
R "$(jq -nc --arg ext $PWD/builds/p440v2 '{ext:$ext,display:":43",tag:"v2-c-fill-undo",url:"http://127.0.0.1:8931/signup",prompt:"帮我把报名表填上：姓名王五，手机13700000000，备注带水。不要提交。",maxSec:150,record:true,after:[{shot:"receipt",wait:2000},{click:".plan-card .plan-details",shot:"details",wait:2500},{click:".plan-card .plan-undo",shot:"undo",wait:3500}]}')"
