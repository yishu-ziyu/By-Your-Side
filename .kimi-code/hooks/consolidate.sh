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

mkdir -p "$WIKI"
log="$WIKI/consolidate.log"
printf '[%s] session=%s event=SessionEnd\n' "$(date -u +%FT%TZ)" "$sid" >> "$log"

# 短会话不值得复盘（省 token）
if [ "$(wc -l < "$wire" | tr -d ' ')" -lt 50 ]; then
  printf 'session=%s skipped=short-trace\n' "$sid" >> "$log"
  exit 0
fi

# 10 分钟内不重复跑（避免 archive/exit 双触发或崩溃重启连发）
lock="$WIKI/consolidate.lock"
now=$(date +%s)
if [ -f "$lock" ] && [ $(( now - $(stat -f %m "$lock") )) -lt 600 ]; then
  printf 'session=%s skipped=cooldown\n' "$sid" >> "$log"
  exit 0
fi
touch "$lock"

# -p 接收一个完整提示词参数；显式文件路径避免同名全局 profile 遮蔽。
(
  cd "$PROJECT" || exit 1
  printf '[%s] session=%s started\n' "$(date -u +%FT%TZ)" "$sid"
  KIMI_CONSOLIDATE_CHILD=1 nohup kimi --agent-file "$PROJECT/.kimi-code/agents/consolidator.md" \
    -p "复盘会话轨迹：${wire}（来源会话 id: ${sid}）。按你的职责流程执行。"
  result=$?
  printf '[%s] session=%s finished exit=%s\n' "$(date -u +%FT%TZ)" "$sid" "$result"
  # 失败不能占住十分钟冷却期；成功才保留去重标记。
  if [ "$result" -ne 0 ]; then
    touch -t 197001020000 "$lock"
  fi
) </dev/null >> "$log" 2>&1 &
exit 0
