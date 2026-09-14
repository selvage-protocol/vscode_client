{
  description = "Selvage's VS Code client: a Node dev shell and the server-free checks";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Node 22 and nothing else. Deliberately no git hooks: the hook set that installs itself
      # into whatever repository the shell is started in belongs to `reference_server`, and a
      # JavaScript repository has no use for it.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
      });

      checks = forAllSystems (
        pkgs:
        let
          node = pkgs.nodejs_22;

          # The dependency tree is built from the lock file, not taken from a checkout's
          # `node_modules`: that directory is ignored by git and so never reaches the store copy
          # a flake sees.
          nodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = self;
            nodejs = node;
            derivationArgs = {
              nativeBuildInputs = [ pkgs.pkg-config ];
              buildInputs = [ pkgs.libsecret ];
            };
          };

          # Both suites run in a writable copy of the source with the store's tree linked in —
          # `test:fast` builds into `dist/`, and a store path is read-only.
          #
          # The suite's own output goes to stderr, and `$out` gets one stable line: the log
          # carries per-test timings, and a derivation whose output differs from build to build
          # is one `nix build --rebuild` rightly calls non-deterministic.
          mkSuite =
            name: steps:
            pkgs.runCommand name
              {
                nativeBuildInputs = [ node ];
              }
              ''
                cp -r ${self} work
                chmod -R u+w work
                ln -s ${nodeModules}/node_modules work/node_modules
                cd work
                export HOME=$TMPDIR
                log=$TMPDIR/suite.log
                if (${pkgs.lib.concatStringsSep " && " steps}) > $log 2>&1; then
                  cat $log >&2
                  echo "${name}: passed" > $out
                else
                  cat $log >&2
                  echo "${name}: FAILED" > $out
                  exit 1
                fi
              '';
        in
        {
          typecheck = mkSuite "vscode-client-typecheck" [ "npm run typecheck" ];

          # The server-free half. The four tests in `test/selvaged.test.ts` are not here: they
          # need a `selvaged` from the sibling `reference_server` checkout, which a sandboxed
          # build cannot see. `SELVAGE_SELVAGED` is the seam for those.
          fast = mkSuite "vscode-client-test-fast" [ "npm run test:fast" ];
        }
      );
    };
}
