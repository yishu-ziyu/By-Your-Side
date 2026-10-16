#!/bin/bash
# usage: lane.sh "1 2 3"  (run 1 recorded)
cd /workspace/proto-bot/overnight; export EGO_ACCEPTANCE_CHROME=/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
P="帮我订一下11月20日上海浦东(PVG)飞东京成田(NRT)的机票，2个大人。只要直飞，航空公司只考虑国航(Air China)或全日空(ANA)，在符合条件的里面选最便宜的。乘客表请这样填：乘客1：Title 选 MR，First name Wei，Last name Zhang，Date of birth 1988-03-14，Nationality 选 China，Passport number E12345678，Passport expiry 2031-06-30，Frequent flyer no. 留空。乘客2：Title 选 MS，First name Lin，Last name Chen，Date of birth 1990-11-02，Nationality 选 China，Passport number E87654321，Passport expiry 2030-09-15，Frequent flyer no. 留空。联系人：Email zhang.wei@example.com，Phone +86 13800001111。两位乘客的常旅客号都留空。停在付款页，不要付款，告诉我航班号、起飞时间和总价。"
C='JSON.stringify({path:location.pathname+location.search,flight:document.querySelector("#pay_flight")?.textContent,dep:document.querySelector("#pay_dep")?.textContent,total:document.querySelector("#pay_total")?.textContent})'
for n in $1; do rec=false; [ $n = 1 ] && rec=true
 curl -s http://127.0.0.1:8991/__reset >/dev/null
 timeout 320 node run-rec.mjs "$(jq -nc --arg ext $PWD/builds/wt-ba3d11a8/extension/dist --arg t ego-passenger/r$n --arg p "$P" --arg c "$C" --argjson r $rec '{ext:$ext,display:":91",tag:$t,url:"http://127.0.0.1:8991/search",prompt:$p,maxSec:240,record:$r,check:$c}')" 2>&1 | tail -1 | cut -c1-300
 curl -s http://127.0.0.1:8991/__state > runs/ego-passenger/r$n/state.json
 echo "DONE r$n $(date +%T)"; done
