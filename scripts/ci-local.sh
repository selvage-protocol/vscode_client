#!/usr/bin/env bash
#
# Runs the steps of .github/workflows/ci.yml on this machine, without containers (this host
# has no Docker or Podman, so `act` cannot run here).
#
#   scripts/ci-local.sh client   # the `checks` job: the release workflow's dry_run gating, typecheck,
#                                # build, the server-free suite
#   scripts/ci-local.sh lint     # actionlint over the workflow files
#   scripts/ci-local.sh links    # lychee over README.md and docs/
#   scripts/ci-local.sh all      # lint + client + links
#
# Keep this in step with the workflow — it runs the same commands, so that a red job is found
# here rather than on a runner. `lint` catches unknown actions, bad expressions and shell
# mistakes statically; the workflow has no actionlint step of its own, so that one is local-only
# and needs `nix`.
#
# CI runs the server-free suite only: the four suites that need a built `selvaged` from the
# sibling `reference_server` checkout — `test/relay-selvaged.test.ts`,
# `test/selvage2-selvaged.test.ts`, `test/selvage2-reconnect-selvaged.test.ts` and
# `test/interop-v2.test.ts` — are not in `npm run test:fast`, and nothing here builds that server.
# The interop suite needs an `interop_peer` from that checkout as well
# (`cargo build -p selvage-harness --example interop_peer`, or `SELVAGE_INTEROP_PEER` at one).
# `npm test` runs every suite and `npm run test:interop` runs the interop one, both with a
# server built. CI pins Node 24.18.1, the version `engines.node` names; this uses whatever `node`
# is on PATH.
#
# `links` needs neither node nor nix: it takes `lychee` from PATH when there is one, which is how
# the runner runs it, and else from a nix shell. What it checks and what it does not is
# `lychee.toml`'s comment.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

# `/tmp` is a RAM-backed tmpfs on some hosts, and building there has taken a machine down
# before; keep every artefact inside the checkout.
export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

say() { printf '\n=== %s ===\n' "$*"; }

run_lychee() {
  if command -v lychee >/dev/null 2>&1; then
    lychee "$@"
  else
    nix shell nixpkgs#lychee -c lychee "$@"
  fi
}

job_client() {
  # The system whose flake checks this builds; the flake carries them for both Linux architectures.
  # Read here rather than at the top: this is the mode that needs nix, while `links` takes its
  # lychee from PATH and has to run on a host that has none.
  local system
  system=$(nix eval --raw --impure --expr builtins.currentSystem)
  # The guard around a workflow's `dry_run` input reads `.github/workflows`, so none of the suites
  # below covers it. The flake check runs the same two files `ci.yml` runs, with the flake's Python
  # supplying the PyYAML that job installs.
  say "client: the release workflow's dry_run gating"
  nix build ".#checks.${system}.dry-run-gating" --no-link --print-build-logs
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

# `README.md` and `docs/` rather than every Markdown file here: this is the reader-facing front
# matter, which is what the gate is about. `lychee.toml` carries the scope note and the excludes.
job_links() {
  say "links: lychee over README.md and docs/"
  run_lychee --config lychee.toml --no-progress README.md docs
}

case "${1:-all}" in
  client) job_client ;;
  lint) job_lint ;;
  links) job_links ;;
  all) job_lint && job_client && job_links ;;
  *)
    printf 'usage: %s [client|lint|links|all]\n' "$0" >&2
    exit 2
    ;;
esac
