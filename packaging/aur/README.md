# AUR packaging (kecilin-bin)

The [PKGBUILD](PKGBUILD) repackages the `.deb` that CI attaches to every
[GitHub Release](https://github.com/DarkTama/Kecilin/releases). On Linux,
Kecilin uses the **system ffmpeg** (declared as a dependency) — no bundled
sidecar.

## Test locally (no AUR account needed)

```
cd packaging/aur
updpkgsums          # fetches the .deb and fills in the real sha256
makepkg -si         # build + install
kecilin
```

## Publish to AUR (one-time setup)

1. Create an account at <https://aur.archlinux.org> and add an SSH key.
2. `git clone ssh://aur@aur.archlinux.org/kecilin-bin.git`
3. Copy `PKGBUILD` in, run `updpkgsums` and
   `makepkg --printsrcinfo > .SRCINFO`, commit, push.

## Per-release bump

Change `pkgver`, reset `pkgrel=1`, re-run `updpkgsums` +
`makepkg --printsrcinfo > .SRCINFO`, commit, push. (This can be automated
later with an AUR-publish GitHub Action once an SSH deploy key exists.)

## Notes

- The `.deb` asset is named `Kecilin_<version>_amd64.deb` (capital K, from
  the Tauri bundler) — GitHub asset URLs are case-sensitive, so `source=`
  matches that exactly (verified against the v0.7.0 release).
- Clipboard file-copy and drag-out are Windows-only right now; the Linux
  build hides those buttons (everything else works, including previews and
  the trim editor).
