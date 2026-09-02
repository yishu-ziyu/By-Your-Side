#!/bin/bash
# PreCompact hook：上下文压缩前归档完整轨迹（可恢复 fold，ContextPilot foldHistory 的穷人版）。
# 压缩后若需找回早期细节，可查 .kimi-code/wiki/fold-archive/。
# 注意：PreCompact 返回值被完全忽略，本 hook 只做归档，无法干预压缩本身。
PROJECT="/Users/mahaoxuan/Desktop/ego"

input=$(cat)
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd": *"\([^"]*\)".*/\1/p' | head -1)
[ "$cwd" = "$PROJECT" ] || exit 0

sid=$(printf '%s' "$input" | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$sid" ] || exit 0
wire=$(find "$HOME/.kimi-code/sessions" -path "*${sid}/agents/main/wire.jsonl" 2>/dev/null | head -1)
[ -f "$wire" ] || exit 0

dest="$PROJECT/.kimi-code/wiki/fold-archive"
mkdir -p "$dest"
cp "$wire" "$dest/$(date +%Y%m%d-%H%M%S)-${sid}.jsonl"
exit 0
