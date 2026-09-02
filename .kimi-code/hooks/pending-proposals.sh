#!/bin/bash
# UserPromptSubmit hook：有待审 skill 提案时向上下文注入提醒（裁决自动浮现，不靠用户记忆）。
PROJECT="/Users/mahaoxuan/Desktop/ego"

input=$(cat)
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd": *"\([^"]*\)".*/\1/p' | head -1)
[ "$cwd" = "$PROJECT" ] || exit 0

n=$(find "$PROJECT/.kimi-code/wiki/proposals" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -gt 0 ]; then
  printf '[wiki] .kimi-code/wiki/proposals/ 中有 %s 条待审 skill 提案。请在本次回复中简要告知用户，并询问是否现在裁决（接受/拒绝/修改）；裁决后把提案移出 proposals/ 并在 .kimi-code/wiki/logs.md 记一行。\n' "$n"
fi
exit 0
