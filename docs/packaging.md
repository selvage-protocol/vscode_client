# Packaging and publishing

`.github/workflows/release.yml` packages the extension, attaches the `.vsix` to the GitHub Release
and publishes it to the Marketplace and to Open VSX as `selvage-protocol.selvage`; the owner
triggers a release from that workflow. `npm run package` runs `vsce package`, which runs the `npm run build`
used everywhere else first, so the `.vsix` always carries a fresh `dist/extension.js`.
`scripts/build.mjs` leaves only `vscode` external, so that one file bundles the engine, the bridge,
`ws`, `yjs` and `y-protocols`; there is no `node_modules/` in the `.vsix`. `vsce package -o <path>`
writes it somewhere other than the repo root.

## The listing icon

`package.json`'s `icon` is `images/icon.png`, and the Marketplace and Open VSX show that file in
the listing. It is the owner's opaque 800×800 export (the `svp` wordmark on its own field),
averaged whole to 256×256 with no colour change, so the wordmark sits where the owner put it
rather than filling the canvas edge to edge. The icon it replaces was a centred 580×580 crop of
the same export, which cut the owner's field away. `scripts/make-icon.mjs` is the producer:

```console
$ node scripts/make-icon.mjs ~/pictures/profile_pictures/profile_picture_svp_800_800.png
$ node scripts/make-icon.mjs ~/pictures/profile_pictures/profile_picture_svp_800_800.png --check
```

The export is not vendored here: the manifest needs the 256 px icon and nothing else, so the
script takes the path as its argument, or from `SELVAGE_ICON_EXPORT`. The same bytes are in the
sibling `site` checkout as `app/opengraph-image.png` (sha256 `9bf1980d…`). `--check` re-derives
the icon in memory and fails when the committed pixels are not that derivation, so it is the pin
to run after the export changes; it is not part of `scripts/ci-local.sh`, which has no export to
read.
