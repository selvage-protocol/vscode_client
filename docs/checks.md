# Checks

```console
$ npm run build                        # → dist/extension.js
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then the server-free suite
$ npm test                             # builds, then the same plus four against a real selvaged
$ npm run test:relay-selvaged          # a selvage/2 host and guest over a real selvaged
$ npm run test:peer-corpus             # the peer corpus, against this engine's own subject
$ npm run test:interop                 # interop with a real Rust client over the sealed wire
$ scripts/ci-local.sh all              # actionlint over the workflows, then the client job
```

`scripts/ci-local.sh all` is the gate before a push and runs the same commands as
`.github/workflows/ci.yml`. `all` is `lint` plus `client` plus `links`: `lint` needs `nix`; `client`
is the `dry_run` gating check (the flake check `dry-run-gating`, which reads `.github/workflows`
back and refuses a workflow whose plan step is followed by a step that a dry run would still run),
then `npm ci`, `typecheck`, `build` and `test:fast`. `links` is the link check over this
repository's reader-facing prose, `README.md` and `docs/`:

```console
$ scripts/ci-local.sh links
```

CI runs the server-free suite only, because the four suites that need a built `selvaged` from the
sibling `reference_server` checkout (`test/relay-selvaged.test.ts`,
`test/selvage2-selvaged.test.ts`, `test/selvage2-reconnect-selvaged.test.ts` and
`test/interop-v2.test.ts`) are not in it, and the workflow does not have that checkout.
`test:peer-corpus` needs the sibling `specification` checkout for the same reason, and
`SELVAGE_SPECIFICATION` names another one; `npm test` runs it along with `test/interop-v2.test.ts`,
which needs the sibling `reference_server` and an `interop_peer` built from it that speaks
`selvage/2` (`SELVAGE_INTEROP_PEER` names one).

```console
$ nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'
```

`test:relay-selvaged` and `test:selvage2` find that binary at
`../reference_server/target/{debug,release}/selvaged`, or wherever `SELVAGE_SELVAGED` points. A
missing binary fails the test, which prints the command that builds it. `cargo` is not on the
ambient `PATH`, and `nix develop ../reference_server` runs its command with the current directory,
hence the `cd`. That flake's shellHook installs Rust git hooks into this checkout; they are
harmless and ignored, and CI does not use them. `nix flake check` runs the server-free half in a
sandbox, where a check cannot build a sibling checkout, and `dry-run-gating`, which reads
`.github/workflows` and neither node's tree nor a sibling.

The suite runs against a fake `selvaged` (`test/helpers/fake-server.ts`) for the faults the real
server will not produce on demand (a dropped socket, a hostile `x.` event, `/meta` naming a
version this client cannot speak). Waits are bounded polls of a real predicate that report the
state they observed on failure (`test/helpers/wait.ts`). `test/manifest.test.ts` loads the built
bundle and activates it against a stub `vscode`, which is how CI checks the manifest without an
editor.

`test/e2e/run.ts` builds the most: it starts a real `selvaged`, resolves a pinned VS Code build
(`1.137.0` by default; set `SELVAGE_E2E_VSCODE_VERSION` to move it) and launches two real
Extension Development Host processes, headless under Xvfb, one hosting and one joining by invite
through a window reload, and asserts their documents converge. It has heavier prerequisites than
everything else here (a network, Xvfb, an internet download the first time, and `nix` for the
shared-library path a VS Code build downloaded outside `nix` needs on NixOS), so it is a manual
verification step: run `scripts/e2e/run-two-instance.sh` from the repository root.
