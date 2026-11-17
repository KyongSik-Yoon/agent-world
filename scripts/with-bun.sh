#!/bin/sh
# herdr 는 플러그인 명령을 제가 띄워진 환경으로 돌린다. 그 PATH 에는 ~/.bun/bin 이나 버전 관리자의 자리가
# 빠져 있을 수 있어서(로그인 셸이 아닌 곳에서 띄운 herdr), bun 이 흔히 깔리는 자리를 더 찾아본 뒤 넘긴다.
for dir in "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims" /opt/homebrew/bin /home/linuxbrew/.linuxbrew/bin /usr/local/bin; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="$PATH:$dir" ;;
  esac
done
export PATH
if ! command -v bun >/dev/null 2>&1; then
  echo "Agent World needs Bun, and 'bun' was not found on PATH or in the usual places (~/.bun/bin, ~/.local/bin, mise/asdf shims, Homebrew, /usr/local/bin)." >&2
  echo "Install it — curl -fsSL https://bun.sh/install | bash — then run this again." >&2
  echo "Agent World 는 Bun 이 필요합니다. bun 을 설치한 뒤 다시 실행해 주세요." >&2
  exit 127
fi
exec bun "$@"
