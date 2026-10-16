#!/bin/bash
# self-test form-fill lane. usage: lane.sh DISPLAY "form:build form:build ..."
cd /workspace/proto-bot/overnight; export EGO_ACCEPTANCE_CHROME=/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
CHK='JSON.stringify(Object.fromEntries([...document.querySelectorAll("input,select,textarea")].map(e=>[e.id,e.type==="checkbox"?e.checked:e.value])).concat ? "" : JSON.stringify(Object.fromEntries([...document.querySelectorAll("input,select,textarea")].map(e=>[e.id,e.type==="checkbox"?e.checked:e.value])))'
declare -A P
P[a]="打开的是本地测试页注册表单。请帮我填写：姓名 林晓雨，邮箱 linxy@example.com，手机号 13900001234，公司 青石科技，职位选 产品经理，勾选「我同意服务条款」，不要勾选订阅资讯。只填写，不要点注册。"
P[b]="打开的是本地测试页项目登记表。请填写：项目名 星河计划；项目信息里的标题 年度增长报告；副标题 第三季度复盘；首篇文章的标题 用户访谈小结；首篇文章的备注 初稿待审。其他区域的字段留空。只填写，不要点保存。"
P[c]="打开的是本地测试页。请点「预约服务」打开弹窗，然后填写：联系人 周子航，到店日期 2026-11-05，服务类型选 保养，备注 上午十点后到。只填写，不要点确认预约。"
P[b2]="本地测试页项目登记表，帮我填一下：标题写 用户访谈小结（这是文章的），项目的标题写 年度增长报告，项目名 星河计划，副标题 第三季度复盘，文章备注 初稿待审。别的不要动，也不要保存。"
n=0
for job in $2; do
  [ "$(date +%H%M)" -ge 1135 ] && { echo "STOP launching $(date +%T)"; break; }
  f=${job%%:*}; b=${job##*:}; n=$((n+1)); tag=formfill/$f-$b-d$1-${R:-}$n
  [ $b = main ] && ext=$PWD/builds/ff-wt-main || ext=$PWD/builds/ff-wt-440-on-main
  timeout 260 node run-ff.mjs "$(jq -nc --arg ext $ext --arg d :$1 --arg t $tag --arg u http://127.0.0.1:8966/${f:0:1} --arg p "${P[$f]}" --arg c 'JSON.stringify(Object.fromEntries([...document.querySelectorAll("input,select,textarea")].map(e=>[e.id,e.type==="checkbox"?e.checked:e.value])))' '{ext:$ext,display:$d,tag:$t,url:$u,prompt:$p,maxSec:200,check:$c}')" 2>&1 | tail -1 | cut -c1-200
  echo "DONE $tag $(date +%T)"
done
