#!/usr/bin/env bash
#
# Runs the steps of .github/workflows/ci.yml on this machine, without containers (this host
# has no Docker or Podman, so `act` cannot run here).
#
#   scripts/ci-local.sh client   # the `checks` job: typecheck, build, the server-free suite
#   scripts/ci-local.sh lint     # actionlint over the workflow files
#   scripts/ci-local.sh all      # lint + client
#
# Keep this in step with the workflow — it runs the same commands, so that a red job is found
# here rather than on a runner. `lint` catches unknown actions, bad expressions and shell
# mistakes statically; the workflow has no actionlint step of its own, so that one is local-only
# and needs `nix`.
#
# CI runs the server-free suite only: the four tests in `test/selvaged.test.ts` need a built
# `selvaged` from the sibling `reference_server` checkout, which the workflow does not have.
# `test/interop.test.ts` needs that checkout too, and `interop_peer` built from it
# (`cargo build -p selvage-harness --example interop_peer`, or `SELVAGE_INTEROP_PEER` at one),
# so it is not here either: `npm test` and `npm run test:interop` run both, with a server
# built. CI pins Node 22.18.0; this uses whatever `node` is on PATH.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# `/tmp` is a RAM-backed tmpfs on some hosts, and building there has taken a machine down
# before; keep every artefact inside the checkout.
export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

say() { printf '\n=== %s ===\n' "$*"; }

job_client() {
  say "client: install"
  npm ci --no-audit --no-fund
  say "client: typecheck"
  npm run typecheck
  say "client: build"
  npm run build
  say "client: the server-free suite"
  npm run test:fast
}

job_lint() {
  say "lint: actionlint over the workflows"
  nix shell nixpkgs#actionlint -c actionlint
}

case "${1:-all}" in
  client) job_client ;;
  lint) job_lint ;;
  all) job_lint && job_client ;;
  *)
    printf 'usage: %s [client|lint|all]\n' "$0" >&2
    exit 2
    ;;
esac
