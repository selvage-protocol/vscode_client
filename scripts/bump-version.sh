#!/usr/bin/env bash
#
# Set this repository's release version in every file that carries it. The release coordinator
# calls this; the caller commits, tags and pushes.
#
#   scripts/bump-version.sh 0.5.2
#
# Three files carry the version, and a release that moves one and not the others is a red run or a
# client that reports a version it is not:
#
#   package.json              the manifest, which `release.yml` asserts the dispatch input and
#                             the tag name against
#   package-lock.json         the root `version` and the same key under `packages.""`, which npm
#                             copies from the manifest
#   src/adapter/extension.ts  the `CLIENT` string the adapter sends in `session.hello`
#                             (`specification/PROTOCOL.md` §5), held to the manifest version by
#                             `test/manifest.test.ts`
#
# Nothing else here carries it — the README names no release, and the release workflow's `version`
# input is required with no default — and `test/bump-version.test.ts` holds the file set above, so
# a fourth home cannot appear without that test failing.
#
# Every spot is found by the shape of the key that carries it rather than by the version it holds,
# and each is written only when it does not already carry the version asked for. So a tree where
# the manifest was bumped by hand and a companion was not is repaired rather than reported as done:
# `already at` is said only when every file agrees, which is the state a release needs.
#
# The version is `X.Y.Z`: three plain decimal components and nothing else, the rule
# `specification/scripts/check-release-version.sh` applies to a dispatch input. A `case` glob is
# not that rule — `[0-9]*.[0-9]*.[0-9]*` admits `1.2.3-rc1`, `1x2.3.4` and `1.2.3/../x` — so the
# character check and the shape check are separate.
#
# Every spot is located before the first is written, so a file whose shape has moved refuses with
# the tree as it was rather than leaving a half-bumped one behind.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <X.Y.Z>\n' "${0##*/}" >&2
  exit 2
fi

new=$1

case "$new" in
  '' | *[!0-9.]*)
    printf 'refusing: %q is not a release version\n' "$new" >&2
    exit 1
    ;;
esac

if ! [[ $new =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf 'refusing: %s is not a release version\n' "$new" >&2
  exit 1
fi

# The manifest's own version, for the report. The decision below does not read it: the version a
# tree carries is the one every file carries, not the one the manifest carries while a companion
# lags behind it.
current=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' package.json)
if [ -z "$current" ] || [ "$(printf '%s\n' "$current" | wc -l)" -ne 1 ]; then
  printf 'refusing: cannot read one version from package.json\n' >&2
  exit 1
fi

# locate <file> <ere>: the one line the pattern names, refusing when it names none or more than
# one.
locate() {
  local file=$1 pattern=$2 hits
  hits=$(grep -c -E -- "$pattern" "$file" || true)
  if [ "$hits" != 1 ]; then
    printf 'refusing: %s has %s line(s) matching %s, want one; nothing written\n' "$file" "$hits" "$pattern" >&2
    exit 1
  fi
  grep -n -E -- "$pattern" "$file" | cut -d: -f1
}

# Only the top level of each file carries a `version` at two spaces, so these two cannot reach a
# dependency's own entry, which is nested.
manifest_line=$(locate package.json '^  "version": "[^"]*",$')
lock_root_line=$(locate package-lock.json '^  "version": "[^"]*",$')
client_line=$(locate src/adapter/extension.ts "^const CLIENT = 'selvage-vscode/[^']*';$")

# The lockfile's second copy of the manifest version sits in the root package entry,
# `packages.""`, which is laid out exactly like a dependency's entry: found by walking `packages`
# to the empty key, not by an indentation a dependency also has.
lock_package_line=$(awk '
  /^  "packages": \{$/ { packages = 1; next }
  packages && /^    "": \{$/ { root = 1; next }
  root && /^      "version": "[^"]*",$/ { print NR; exit }
  root && /^    \},$/ { exit }
' package-lock.json)
if [ -z "$lock_package_line" ]; then
  printf 'refusing: package-lock.json carries no version in packages.""; nothing written\n' >&2
  exit 1
fi

# What each spot becomes. The whole line is replaced, addressed by its number, so no dependency's
# version line in the lockfile can be reached even in principle.
files=(package.json package-lock.json package-lock.json src/adapter/extension.ts)
lines=("$manifest_line" "$lock_root_line" "$lock_package_line" "$client_line")
targets=(
  "$(printf '  "version": "%s",' "$new")"
  "$(printf '  "version": "%s",' "$new")"
  "$(printf '      "version": "%s",' "$new")"
  "$(printf "const CLIENT = 'selvage-vscode/%s';" "$new")"
)

changed=()
for i in "${!files[@]}"; do
  file=${files[$i]}
  if [ "$(sed -n "${lines[$i]}p" "$file")" = "${targets[$i]}" ]; then
    continue
  fi
  sed -i "${lines[$i]}s|.*|${targets[$i]}|" "$file"
  if [[ ! " ${changed[*]-} " == *" $file "* ]]; then
    changed+=("$file")
  fi
done

if [ "${#changed[@]}" -eq 0 ]; then
  printf 'already at %s in every file that carries it; nothing changed\n' "$new"
  exit 0
fi

if [ "$current" = "$new" ]; then
  printf 'package.json already carried %s; wrote the file(s) that lagged:\n' "$new"
else
  printf 'set %s -> %s in:\n' "$current" "$new"
fi
printf '  %s\n' "${changed[@]}"
