#!/usr/bin/env bash
# 이 저장소에서 일하다 끝난 Claude Code 세션이 남긴 bun 프로세스를 거둔다. 세션을 열 때 훅이 부른다(.claude/settings.json).
#
# 세션이 시험하려고 떼어 띄운(setsid·nohup·&) bun 은 세션이 끝나도 systemd 밑에 남는다. Claude Code 는 자기가 띄우는
# 모든 명령에 CLAUDE_PID(자기 pid)를 환경변수로 넘기고, 이 표식은 부모가 바뀌어도 /proc/<pid>/environ 에 남는다.
#
# 거두는 조건 — 모두 채워야 한다:
#   1. 실행 파일이 bun 이다(/proc/<pid>/exe. 명령줄 글자로 고르지 않는다)
#   2. environ 에 CLAUDE_PID 가 있다(Claude 세션이 띄운 것)
#   3. 그 pid 가 없거나, claude 가 아니거나, 이 프로세스보다 늦게 태어났다(pid 재사용)
#   4. systemd 까지 올라가는 조상이 bun·셸·setsid 류뿐이다(떼어져 혼자 남은 것)
#   5. 이 저장소의 것이다: 작업 폴더가 이 저장소(와 그 worktree) 안이거나, 여기서 연 세션이 띄웠다
# 같은 표식을 단 다른 것들(git fsmonitor, codex app-server, 세션에서 연 크롬…)은 1 에서 빠지고, 그런 살아 있는 프로그램이
# 지금 부리고 있는 bun(Codex 가 돌리는 bun test 등)은 4 에서 빠진다.
# 세션이 끝난 뒤에도 남아야 하는 bun 은 CLAUDE_PID 를 빼고 띄우거나(env -u CLAUDE_PID …) CLAUDE_REAP_KEEP=1 을 준다.
#
#   reap-orphan-bun.sh            거둔다(TERM, 3초 뒤에도 남으면 KILL)
#   reap-orphan-bun.sh --dry-run  죽이지 않고 무엇이 걸리는지만 찍는다
#
# 거둔 것은 ~/.local/state/agent-world/reap.log 에 남긴다.

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-world"
LOG="$LOG_DIR/reap.log"

# 이 저장소의 폴더들(본 폴더와 worktree). git 이 없으면 이 스크립트가 든 폴더 하나.
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
roots=()
while IFS= read -r line; do
  case "$line" in "worktree "*) roots+=("${line#worktree }") ;; esac
done < <(git -C "$ROOT" worktree list --porcelain 2>/dev/null)
[ "${#roots[@]}" -gt 0 ] || roots=("$ROOT")

# 작업 폴더($1)나 세션이 열린 폴더의 표식($2. Claude Code 는 임시 폴더 이름에 프로젝트 경로를 글자·숫자 밖은 '-' 로 바꿔
# 넣는다)이 이 저장소를 가리키면 참. 뒤쪽은 세션이 임시로 만든 worktree 가 이미 지워진 경우를 잡는다.
ours() {
  local root cwd=${1% (deleted)}
  for root in "${roots[@]}"; do
    case "$cwd/" in "$root"/*) return 0 ;; esac
    case "$2" in */"${root//[^A-Za-z0-9]/-}"/*) return 0 ;; esac
  done
  return 1
}

# /proc/<pid>/stat 의 22번째 칸(부팅 뒤 태어난 시각). comm 에 빈칸·괄호가 들어갈 수 있어 마지막 ')' 뒤부터 센다.
born() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  set -- $stat
  echo "${20}"
}

owner_alive() { # $1 = CLAUDE_PID, $2 = 살펴보는 프로세스가 태어난 시각
  local exe owner_born
  exe=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  case "${exe##*/}" in claude | claude\ \(deleted\)) ;; *) return 1 ;; esac
  owner_born=$(born "$1") || return 1
  [ "$owner_born" -le "$2" ]
}

# 조상을 따라 올라가 systemd(또는 1번)에 닿을 때까지 bun·셸·떼어 띄우는 도구만 있으면 참.
detached() {
  local at=$1 stat exe hops=0
  while [ "$hops" -lt 32 ]; do
    stat=$(cat "/proc/$at/stat" 2>/dev/null) || return 1
    stat=${stat##*) }
    set -- $stat
    at=$2
    [ "$at" -le 1 ] && return 0
    [ "$(cat "/proc/$at/comm" 2>/dev/null)" = "systemd" ] && return 0
    exe=$(readlink "/proc/$at/exe" 2>/dev/null) || return 1
    exe=${exe% (deleted)}
    case "${exe##*/}" in bun | sh | bash | dash | zsh | fish | setsid | nohup | timeout | env) ;; *) return 1 ;; esac
    hops=$((hops + 1))
  done
  return 1
}

victims=()
for pid in $(pgrep -x -u "$(id -u)" bun); do
  dir=/proc/$pid
  exe=$(readlink "$dir/exe" 2>/dev/null) || continue
  case "${exe##*/}" in bun | bun\ \(deleted\)) ;; *) continue ;; esac
  owner="" keep="" notes=""
  while IFS= read -r -d '' entry; do
    case "$entry" in
      CLAUDE_PID=*) owner=${entry#CLAUDE_PID=} ;;
      CLAUDE_REAP_KEEP=1) keep=1 ;;
      CLAUDE_CODE_CHILD_NOTES_DIR=*) notes=${entry#*=} ;;
    esac
  done <"$dir/environ" 2>/dev/null
  [ -n "$owner" ] && [ -z "$keep" ] || continue
  case "$owner" in *[!0-9]*) continue ;; esac
  mine=$(born "$pid") || continue
  owner_alive "$owner" "$mine" && continue
  detached "$pid" || continue
  ours "$(readlink "$dir/cwd" 2>/dev/null)" "$notes" || continue
  # 고르는 사이 pid 가 다른 프로세스로 바뀌지 않았는지 태어난 시각으로 다시 본다.
  victims+=("$pid:$mine")
  line="$(date '+%F %T') pid=$pid claude=$owner $(tr '\0' ' ' <"$dir/cmdline" 2>/dev/null | cut -c1-300)"
  if [ "$dry" = 1 ]; then
    echo "would reap: $line"
  else
    mkdir -p "$LOG_DIR" && echo "$line" >>"$LOG"
  fi
done

[ "$dry" = 1 ] && exit 0
[ "${#victims[@]}" -gt 0 ] || exit 0

same() { [ "$(born "${1%%:*}" 2>/dev/null)" = "${1##*:}" ]; }

for v in "${victims[@]}"; do same "$v" && kill -TERM "${v%%:*}" 2>/dev/null; done
# 훅을 붙들지 않게 뒤처리는 떼어 놓는다.
(
  sleep 3
  for v in "${victims[@]}"; do same "$v" && kill -KILL "${v%%:*}" 2>/dev/null; done
) </dev/null >/dev/null 2>&1 &
disown
exit 0
