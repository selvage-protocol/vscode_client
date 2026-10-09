#!/usr/bin/env bash
#
# Takes the README's screenshot into `docs/images/marketplace/`: two real VS Code windows in one
# room on a real `selvaged`, the host on an Xvfb display at 1280×800 with the real built extension
# loaded and a guest behind it on its own display, staged through the driver suites under
# `test/screenshots/`. A manual step, run when the extension's look changes, and never part of the
# gate:
#
#   scripts/screenshots/capture.sh
#
# The display, `import` and `xdotool` are this shell's business rather than the dev shell's, so they
# come from `nix shell`; `node` comes from the sibling `reference_server`'s dev shell, the same one
# `scripts/e2e/run-two-instance.sh` runs the two-instance proof under. The image is then
# recompressed losslessly with optipng, through `nix shell`, and has to come out under 1 MB.
# Sandboxes and logs are kept under `.tmp/screenshots/` until the next run.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

reference_server="${SELVAGE_REFERENCE_SERVER:-../reference_server}"
raw="$TMPDIR/screenshots-raw"
out="docs/images/marketplace"
rm -rf "$raw"

nix shell nixpkgs#xvfb nixpkgs#imagemagick nixpkgs#xdotool -c bash -c "
  nix develop '$reference_server' -c node test/screenshots/capture.ts '$raw'
"

# The images this run took, named before anything is published: an empty list is a capture that
# ran and wrote nothing, which is a failure rather than a run with no pictures to check.
shopt -s nullglob
raws=("$raw"/*.png)
shopt -u nullglob
if (( ${#raws[@]} == 0 )); then
  echo "no PNG was written under $raw; test/screenshots/capture.ts is what writes the image" >&2
  exit 1
fi

nix shell nixpkgs#optipng -c optipng -quiet -o5 -strip all "${raws[@]}"

# Validated first, published after: a picture over the size bound fails the run with `$out`
# untouched, and nothing a run leaves there is a file it took. The directory holds what this run
# took and nothing else, so a renamed or dropped picture does not stay behind beside it.
mkdir -p "$out"
rm -f "$out"/*.png
for raw_image in "${raws[@]}"; do
  image="$out/$(basename "$raw_image")"
  size=$(stat -c %s "$raw_image")
  if (( size >= 1048576 )); then
    echo "$image is $size bytes, over the 1 MB a Marketplace screenshot may be" >&2
    exit 1
  fi
  cp "$raw_image" "$image"
  echo "ok: $image, $size bytes"
done
