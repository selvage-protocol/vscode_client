# Checks

```console
$ npm run build                        # → dist/extension.js
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then the server-free suite
$ npm test                             # builds, then the same plus four against a real selvaged
$ npm run test:relay-selvaged          # a selvage/2 host and guest over a real selvaged
$ npm run test:peer-corpus             # the peer corpus, against this engine's own subject
$ npm run test:interop                 # interop with a real Rust client over the sealed wire
$ scripts/ci-local.sh all              # actionlint, then the client job and the link check
```

`scripts/ci-local.sh all` is the gate before a push and runs the same commands as
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). `all` is `lint` plus `client` plus
`links`: `lint` needs `nix`; `client` is the `dry_run` gating check — the flake check
`dry-run-gating`, which reads `.github/workflows` back and refuses a workflow whose plan step is
followed by a step that a dry run would still run — then `npm ci`, `typecheck`, `build` and
`test:fast`. `links` runs `lychee` over this repository's reader-facing prose, `README.md` and
`docs/`; [`lychee.toml`](../lychee.toml) carries the scope note and the addresses it cannot fetch:

```console
$ scripts/ci-local.sh links
```

CI runs the server-free suite only, because the four suites that need a built `selvaged` from the
sibling `reference_server` checkout —
[`test/relay-selvaged.test.ts`](../test/relay-selvaged.test.ts),
[`test/selvage2-selvaged.test.ts`](../test/selvage2-selvaged.test.ts),
[`test/selvage2-reconnect-selvaged.test.ts`](../test/selvage2-reconnect-selvaged.test.ts) and
[`test/interop-v2.test.ts`](../test/interop-v2.test.ts) — are not in it, and the workflow does not
have that checkout.
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

The suite runs against a fake `selvaged`
([`test/helpers/fake-server.ts`](../test/helpers/fake-server.ts)) for the faults the real server
will not produce on demand (a dropped socket, a hostile `x.` event, `/meta` naming a version this
client cannot speak). Waits are bounded polls of a real predicate that report the state they
observed on failure ([`test/helpers/wait.ts`](../test/helpers/wait.ts)).
[`test/manifest.test.ts`](../test/manifest.test.ts) loads the built bundle and activates it against
a stub `vscode`, which is how CI checks the manifest without an editor.

[`test/e2e/run.ts`](../test/e2e/run.ts) builds the most: it starts a real `selvaged`, resolves the
VS Code build the manifest declares — `1.137.0`, the `engines.vscode` floor, so the declared floor
is the one exercised; set `SELVAGE_E2E_VSCODE_VERSION` to move it for a one-off run — and launches
two real Extension Development Host processes, headless under Xvfb, one hosting and one joining by
invite through a window reload, and asserts their documents converge. It has heavier prerequisites
than everything else here (a network, Xvfb, an internet download the first time, and `nix` for the
shared-library path a VS Code build downloaded outside `nix` needs on NixOS), so it is a manual
verification step: run `scripts/e2e/run-two-instance.sh` from the repository root.

Three numbers describe the editor floor and they are one number: `engines.vscode` is `^1.137.0`,
the `@types/vscode` pin is `1.137.0`, and the build the e2e launches by default is `1.137.0`.
[`test/manifest.test.ts`](../test/manifest.test.ts) fails when the e2e's default and the manifest
drift apart, so raising the floor means moving both.

`engines.node` names the extension host that build runs, and it is Node 24: 24.18.1, which the
build's own Electron reports — `ELECTRON_RUN_AS_NODE=1 <build>/code -e 'process.versions.node'`,
with the shared-library path the run above needs on NixOS. So `scripts/build.mjs` compiles for
`node24`, CI pins 24.18.1 and the dev shell carries nixpkgs' own Node 24, which makes the suite run
on the runtime the extension is installed into. `@types/node` stays at `^26`, a major *ahead* of
both runtimes rather than at the floor: pinned to 24, `tsc --noEmit` fails with `'CryptoKey' refers
to a value, but is being used as a type here` in `src/engine/crypto-web.ts` and two test files,
because the global `CryptoKey` and `SubtleCrypto` type names only arrive in `@types/node` 25. The
engine is a copy three other clients vendor, so the pin stays where it is and the runtime is
exercised by the e2e rather than by the types.
