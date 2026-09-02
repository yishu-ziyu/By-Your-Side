#!/bin/bash
# SessionEnd hook：会话结束后自动拉起 consolidator 做离线经验复盘。
# 试点期只对 ego 项目生效（按事件 payload 的 cwd 门控）；推广时放开门控即可。
PROJECT="/Users/mahaoxuan/Desktop/ego"
WIKI="$PROJECT/.kimi-code/wiki"

input=$(cat)

# 防递归：consolidator 自己的会话结束也会触发本 hook，必须直接退出
[ -n "$KIMI_CONSOLIDATE_CHILD" ] && exit 0

cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd": *"\([^"]*\)".*/\1/p' | head -1)
[ "$cwd" = "$PROJECT" ] || exit 0

sid=$(printf '%s' "$input" | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$sid" ] || exit 0
wire=$(find "$HOME/.kimi-code/sessions" -path "*${sid}/agents/main/wire.jsonl" 2>/dev/null | head -1)
[ -f "$wire" ] || exit 0

# 短会话不值得复盘（省 token）
[ "$(wc -l < "$wire" | tr -d ' ')" -lt 50 ] && exit 0

# 10 分钟内不重复跑（避免 archive/exit 双触发或崩溃重启连发）
lock="$WIKI/consolidate.lock"
now=$(date +%s)
if [ -f "$lock" ] && [ $(( now - $(stat -f %m "$lock") )) -lt 600 ]; then exit 0; fi
touch "$lock"

mkdir -p "$WIKI"
cd "$PROJECT" && KIMI_CONSOLIDATE_CHILD=1 nohup kimi -p --agent consolidator \
  "复盘会话轨迹：$wire（来源会话 id: $sid）。按你的职责流程执行。" \
  >> "$WIKI/consolidate.log" 2>&1 &
exit 0
