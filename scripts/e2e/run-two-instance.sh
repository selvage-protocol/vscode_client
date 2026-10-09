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
# `.github/workflows/e2e-current.yml` runs this same script unattended on a weekly schedule
# against the current stable VS Code build, so a VS Code release that breaks the extension is a
# red run rather than a user report.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

export TMPDIR="$repo_root/.tmp"
mkdir -p "$TMPDIR"

reference_server="${SELVAGE_REFERENCE_SERVER:-../reference_server}"

nix shell nixpkgs#xvfb-run -c bash -c "
  xvfb-run -a nix develop '$reference_server' -c node test/e2e/run.ts
"
