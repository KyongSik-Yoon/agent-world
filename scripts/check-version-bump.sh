#!/bin/sh
# main 에 올라가는 묶음(BASE..TIP)이 플러그인 버전을 올렸는지 본다. 올리지 않았으면 1 로 끝난다.
#
# 설치본은 커밋으로 고정되므로 버전을 올리지 않아도 갱신은 되지만, 그러면 갱신 표시의 번호가 실제와 어긋나고
# 릴리스 페이지에 무엇이 바뀌었는지 남지 않는다. 그래서 설치본에 들어가는 파일이 하나라도 바뀐 묶음은
# 버전을 올려야 한다. 같은 검사를 .githooks/pre-push(올리기 전)와 release.yml(올린 뒤)이 함께 쓴다.
#
#   sh scripts/check-version-bump.sh <BASE> <TIP>
set -eu
base=$1
tip=$2

# 설치한 사람에게 닿지 않는 것: 홈페이지, 문서, 저장소 도구 설정.
changed=$(git diff --name-only "$base" "$tip" -- . \
  ':(exclude)docs' ':(exclude)*.md' ':(exclude)LICENSE' ':(exclude).gitignore' \
  ':(exclude).github' ':(exclude).githooks' ':(exclude).claude')
[ -n "$changed" ] || exit 0

toml() { git show "$1:herdr-plugin.toml" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -n 1; }
pkg() { git show "$1:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -n 1; }

old=$(toml "$base")
new=$(toml "$tip")
fail() {
  echo "버전 검사: $1" >&2
  echo "  sh scripts/bump-version.sh        # patch (minor·major 는 인자로)" >&2
  echo "  바뀐 두 파일을 이 묶음의 커밋에 넣고 다시 올린다." >&2
  exit 1
}

[ "$new" = "$(pkg "$tip")" ] || fail "herdr-plugin.toml($new)과 package.json($(pkg "$tip"))의 버전이 다르다."
[ "$new" != "$old" ] || fail "설치본에 들어가는 파일이 바뀌었는데 버전이 $old 그대로다."
[ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -n 1)" = "$new" ] || fail "버전이 $old 에서 $new 로 내려갔다."
