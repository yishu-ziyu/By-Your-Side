#!/bin/bash
# usage: lane.sh DISPLAY "slug slug ..."
cd /workspace/proto-bot/overnight; export EGO_ACCEPTANCE_CHROME=/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
EXT=$PWD/builds/wt-ba3d11a8/extension/dist; T=replicate/_fx/tasks.json
C='JSON.stringify({url:location.href,inputs:Object.fromEntries([...document.querySelectorAll("input[id],select[id],textarea[id]")].map(e=>[e.id,e.type==="checkbox"?e.checked:e.value])),hidden:[...document.querySelectorAll("#shorts,.short")].map(e=>e.checkVisibility()),text:document.body.innerText.slice(0,2500)})'
for slug in $2; do
  url=$(jq -r ".[]|select(.slug==\"$slug\").url" $T); prompt=$(jq -r ".[]|select(.slug==\"$slug\").prompt" $T)
  pre=$(echo "$url" | sed -E 's#http://[^/]+/([^/?]+).*#\1#'); [ $slug = sider-yt-sheets ] && pre=yt
  curl -s "http://127.0.0.1:8995/__reset?s=$pre" >/dev/null
  ms=240; [ $slug = ego-chess ] && ms=420
  timeout $((ms+80)) node run-rec.mjs "$(jq -nc --arg ext $EXT --arg d :$1 --arg t $slug/r1 --arg u "$url" --arg p "$prompt" --arg c "$C" --argjson ms $ms '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:$ms,record:true,check:$c}')" > runs/$slug.log 2>&1
  curl -s "http://127.0.0.1:8995/__state?s=$pre" > runs/$slug/r1/state.json
  f=runs/$slug/r1/result.json; [ -f $f ] && jq '.build="main@ba3d11a8cc635cf84e850130fa2002fadeaf4a02"' $f > $f.tmp && mv $f.tmp $f
  [ -f runs/$slug/r1/video.mp4 ] && cp runs/$slug/r1/video.mp4 replicate/$slug/run.mp4 && ffmpeg -y -loglevel error -sseof -0.5 -i replicate/$slug/run.mp4 -frames:v 1 -update 1 replicate/$slug/final.png
  echo "DONE $slug $(date +%T)"
done
