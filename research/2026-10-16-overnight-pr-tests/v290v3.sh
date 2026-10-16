#!/bin/bash
# #290 v3: decline blocks the whole run. :8931 (never 8957), xvfb :47.
cd /workspace/proto-bot/overnight; EXT=$PWD/builds/p290v3; D=:47; B=http://127.0.0.1:8931
PT='document.querySelector("#messages").innerText'
run(){ curl -s $B/__reset >/dev/null
  node run-task.mjs "$(jq -nc --arg ext $EXT --arg d $D --arg t "v290v3-$1" --arg u "$B/chat" --arg p "$2" --arg c "$3" --argjson a "$4" '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:200,confirm:$c,after:$a}')" 2>&1 | tail -1 | cut -c1-150
  echo "POSTS $1 $(curl -s $B/__posts | jq -c '[.[]|.path]')"; }
A0='[{"text":"#messages","shot":"end","wait":300}]'
for i in 1 2 3; do run dec$i "回复小王：评审明天下午两点开始。写好后发送。" decline "$A0"; done
A1='[{"text":"#messages","click":".send-declined-card .gc-btn","shot":"clicked","wait":45000},{"click":".send-confirm .send-confirm-yes","shot":"confirmed","wait":20000},{"text":"#messages","shot":"end","wait":300}]'
run decsend "回复小王：评审明天下午两点开始。写好后发送。" decline "$A1"
run ok "在聊天框里回复“收到，我会准时参加”，并发出去。" send "$A0"
echo ALLDONE
