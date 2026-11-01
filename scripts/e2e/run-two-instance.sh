#!/usr/bin/env bash
#
# Runs `test/e2e/run.ts`: two real, independent VS Code Extension Development Host processes,
# each with the real built extension, one hosting and one joining over a real `selvaged`,
# proving the documents converge — and, unless `SELVAGE_E2E_RECONNECT=0`, that a guest whose
# socket is cut mid-session reconnects and re-converges.
#
# This is not part of `npm test`/`test:fast`: it downloads a real VS Code build on first
# run, needs Xvfb to run it headless, needs `nix` for the shared-library path an
# Electron binary built outside nix needs on NixOS, and needs a real network path to the
# `selvaged` it starts itself. It is not in `ci.yml` either. Run it here for a one-off;
# `.github/workflows/e2e-current.yml` runs this same script for candidate PRs at the declared
# editor floor, and weekly or on dispatch against stable, so an upstream editor regression is
# a red run rather than a user report.
#
# The proof runs from the sibling `reference_server` flake's dev shell, entered from that
# checkout: `nix develop` runs the shell's `shellHook` in the working directory, so entering it
# from here would install the server shell's Rust git hooks here. The Node that runs the harness
# is this checkout's own — the version `engines.node` names and `ci.yml` pins — asked of the
# caller's `node` as its `process.execPath` before the shell boundary rather than taken from the
# server shell, whose Node differs. `run.ts` resolves its roots from the file, not the working
# directory, so both it and the Node are named by absolute path.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

# Before the server shell, the caller's Node: the pinned version runs the harness, not the
# version the server flake carries. Validated as an absolute executable, and passed on absolutely
# so the shell that runs it cannot substitute its own.
node_bin=$(node -e 'process.stdout.write(process.execPath)')
if [[ "$node_bin" != /* || ! -x "$node_bin" ]]; then
  echo "the caller's node did not resolve to an absolute executable (got '$node_bin')" >&2
  exit 1
fi

reference_server=$(cd -- "${SELVAGE_REFERENCE_SERVER:-$repo_root/../reference_server}" && pwd)
run_ts="$repo_root/test/e2e/run.ts"

cd "$reference_server"
nix shell nixpkgs#xvfb-run -c \
  xvfb-run -a nix develop . -c "$node_bin" "$run_ts"
