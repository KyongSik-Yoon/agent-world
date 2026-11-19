#!/bin/sh
# 플러그인 버전을 올린다: herdr-plugin.toml 과 package.json 을 함께 고치고 새 번호를 찍는다. 커밋은 하지 않는다.
#
#   sh scripts/bump-version.sh [patch|minor|major]     (기본 patch)
set -eu
cd "$(dirname "$0")/.."
cur=$(sed -n 's/^version = "\(.*\)"$/\1/p' herdr-plugin.toml | head -n 1)
IFS=. read -r major minor patch <<EOT
$cur
EOT
case "${1:-patch}" in
  patch) patch=$((patch + 1)) ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  major) major=$((major + 1)); minor=0; patch=0 ;;
  *) echo "usage: bump-version.sh [patch|minor|major]" >&2; exit 2 ;;
esac
new="$major.$minor.$patch"
sed -i.bak "s/^version = \"$cur\"\$/version = \"$new\"/" herdr-plugin.toml
sed -i.bak "s/^  \"version\": \"$cur\",\$/  \"version\": \"$new\",/" package.json
rm -f herdr-plugin.toml.bak package.json.bak
echo "$new"
