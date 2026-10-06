#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
session_name="$(echo "$input" | jq -r '.session_name // empty')"
cwd="$(echo "$input" | jq -r '.workspace.current_dir')"
short_dir="$(echo "$cwd" | awk -F/ '{if (NF <= 2) print $0; else print $(NF-1)"/"$NF;}')"
model_name="$(echo "$input" | jq -r '.model.display_name // empty')"

git_branch=""
if git --no-optional-locks -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch="$(git --no-optional-locks -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git --no-optional-locks -C "$cwd" rev-parse --short HEAD 2>/dev/null)"
  if [[ -n "$branch" ]]; then
    git_branch=" ($branch)"
  fi
fi

context_size="$(echo "$input" | jq -r '.context_window.context_window_size // 200000')"
used_pct="$(echo "$input" | jq -r '.context_window.used_percentage // empty')"

if [[ -n "$used_pct" ]]; then
  tokens_in_context="$(awk -v cs="$context_size" -v pct="$used_pct" 'BEGIN{printf "%d", cs * pct / 100}')"
  if [[ "$tokens_in_context" -ge 1000 ]]; then
    tokens_used="$((tokens_in_context / 1000))k"
  else
    tokens_used="${tokens_in_context}"
  fi
else
  tokens_used="0"
fi

if [[ "$context_size" -ge 1000 ]]; then
  context_display="$((context_size / 1000))k"
else
  context_display="${context_size}"
fi

session_prefix=""
if [[ -n "$session_name" ]]; then
  session_prefix="${session_name} | "
fi

model_suffix=""
if [[ -n "$model_name" ]]; then
  model_suffix=" | ${model_name}"
fi

echo "${session_prefix}${short_dir}${git_branch} [${tokens_used}/${context_display}]${model_suffix}"
