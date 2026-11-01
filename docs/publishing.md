# Publishing the extension

[release.yml](../.github/workflows/release.yml) packages one `.vsix`, attaches it
to a GitHub Release, and publishes that same artifact to the VS Code Marketplace
and Open VSX as `selvage-protocol.selvage`. The registries use unrelated
identities. A successful upload is not immediate listing visibility; query the
registries after propagation before announcing availability.

## Release contract

Merge the candidate with green [CI](../.github/workflows/ci.yml) and
[integration](../.github/workflows/e2e-current.yml) checks. Public workspace
contracts compare the candidate's fixtures and pins against the specification.
Integration runs the real-server suites, peer corpus and mutation census, and
two real editor windows at the declared `engines.vscode` floor on PRs. Weekly
and manual integration runs use `stable` to detect upstream editor changes.
These are automated checks, not a human acceptance claim.

The [public workspace publication order](https://github.com/selvage-protocol/specification/blob/main/docs/workspace-contracts.md#publication-order)
requires the specification checker to be published first and consumer jobs to
pin its reviewed commit. Merge canonical engine or bridge updates here before
the matching Neovim, MCP, and web copies, after each candidate passes its own
gates. The full published census intentionally reports drift during that
transition; run it again after all copies merge rather than weakening it.
The scoped job here checks specification fixtures and the release guard, not
the downstream copies. Its revision log identifies the exact comparison.

Each repository has its own artifact version; the wire version does not change
with an extension release. `package.json` owns this artifact's version and
`scripts/bump-version.sh` moves its copies. Rehearse, then release deliberately:

```sh
gh workflow run release.yml -R selvage-protocol/vscode_client --ref main \
  -f bump=patch -f dry_run=true
gh workflow run release.yml -R selvage-protocol/vscode_client --ref main \
  -f bump=patch
```

Use `minor` or `major` when appropriate. A dispatch refuses unless it is at
`main`, the manifest version already has its exact remote `v<version>` tag, and
the computed target has no such tag. The write job rechecks tag preconditions on
every attempt before bumping, so retrying a job cannot rely on a stale plan.
A dry run resolves and prints the plan but does not run the release gates,
change files, commit, tag, publish, or deploy.

The write job checks the bumped tree before pushing it directly to `main` as the
repository owner. This matters because a push with the workflow's
`GITHUB_TOKEN` does not start ordinary push-triggered checks. A non-fast-forward
push refuses rather than overwriting concurrent work. The release build has no
repository-write or OIDC permission; it hands its `.vsix` and installed publisher
tools to `publish` as artifacts. Only `publish` receives the Marketplace OIDC
permission, and it installs no packages. It verifies the package's source commit
before creating the tag. A `v*` tag push can also release an existing matching
manifest commit; no path is allowed to move an existing release tag.

## Marketplace identity and initial setup

The Marketplace route is `vsce publish --azure-credential`, after federated
Microsoft Entra ID login. Do not substitute `--oidc` unless trusted publishing
has actually been configured for this publisher; it is not an automatic
fallback. No `VSCE_PAT`, client secret, or certificate is needed for this route.
The public app and tenant identifiers are in the release workflow.

The owner provisions the app registration, service principal, federation, and
publisher membership outside CI. Give the app no unrelated Azure subscription
roles. Federation uses issuer `https://token.actions.githubusercontent.com`,
audience `api://AzureADTokenExchange`, and the exact immutable subject:

```text
repo:selvage-protocol@328844633/vscode_client@1368869486:environment:marketplace
```

The `marketplace` GitHub environment supplies that subject for both tag pushes
and dispatches. Its name is part of the credential contract. Declaring an
environment does not itself require approval; inspect its current protection
rules rather than assuming there are reviewers.

The publisher authorizes the identity's **Visual Studio profile ID**, not its
email or Entra application ID. While authenticated as the publishing identity,
read the profile with:

```sh
az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id --output tsv
```

Add that profile to the `selvage-protocol` publisher with permission to update
an existing extension; Creator alone is insufficient. A replacement identity
needs its own profile membership and federation before the old identity is
removed. Updating an extension and deleting one are different privileges.

## Open VSX credential

The owner creates the `selvage-protocol` namespace and grants the token's user
membership. CI reads repository secret `OVSX_TOKEN` and supplies it as
`OVSX_PAT`, never a command-line token argument. Empty credentials fail rather
than silently selecting another authentication route. Publisher tool versions
are pinned in the workflow.

Rotate by creating a new Open VSX access token, updating the repository secret,
verifying a publish, and then revoking the old token:

```sh
gh secret set OVSX_TOKEN -R selvage-protocol/vscode_client
```

Enter the value through the CLI's private input, not a shell argument or a
tracked file. Marketplace federation cannot publish to Open VSX, and the Open
VSX token cannot publish to the Marketplace.

## Verification and partial-release recovery

```sh
gh release view 'v<version>' -R selvage-protocol/vscode_client --json tagName,assets
curl -fsS --max-time 25 -X POST \
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -H 'Content-Type: application/json' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"selvage-protocol.selvage"}],"pageSize":1}],"flags":950}'
curl -fsS --max-time 25 https://open-vsx.org/api/selvage-protocol/selvage
```

Check the returned version, not just an HTTP status or the publish process's
exit code. Gallery caches can lag for minutes. Use bounded polling and retain
the last response when reporting a failed read.

- **Bump pushed but tag missing:** another dispatch refuses, because the
  manifest version is unreleased. Verify the intended commit and manifest,
  create the annotated `v<version>` tag there, and push that tag to take the
  tag-triggered path. Do not bump past an unfinished release accidentally.
- **Tag/Release already exists:** the tag must name the same commit; it is never
  moved. The workflow can refresh the Release asset, but that is not permission
  to republish a registry version.
- **Only one registry published:** the order is GitHub tag/Release, Marketplace,
  then Open VSX. Neither registry step skips duplicates. A rerun can stop on a
  registry that already accepted the version before reaching the missing one.
  Download the failed run's exact `vsix` artifact with `gh run download -R
  selvage-protocol/vscode_client <run-id> -n vsix`, verify its provenance, and
  publish only to the missing registry with the workflow's pinned tool and
  appropriate identity, or cut a new version. A new dispatch computes the next
  version; it is not a same-version recovery button.

Publisher/namespace IDs and `publisher.name` are durable identifiers, not a
release's display name. For a future listing migration, rename the old display
name, publish and verify the replacement, and retire the old listing last.
[rename-listing.yml](../.github/workflows/rename-listing.yml) and
[retire-listing.yml](../.github/workflows/retire-listing.yml) are narrowly scoped
manual tools for the former `selvage-protocol.selvage-client` ID, not routine
release steps. Retirement requires the replacement to be live and explicit
delete permission; a refusal is not a reason to remove that guard.
