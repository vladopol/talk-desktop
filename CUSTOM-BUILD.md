<!--
  - SPDX-FileCopyrightText: 2026 Vladimir Poluliashenko
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Custom build

This fork carries six changes that are not in upstream Nextcloud Talk Desktop yet, and
builds unsigned distributables for Windows, macOS and Linux from them.

Everything here is specific to the fork. Nothing in this document applies to
[nextcloud/talk-desktop](https://github.com/nextcloud/talk-desktop).

## What is in the build

Four of the changes live in the desktop client, two in the built-in Talk (`spreed`),
which is bundled into the app at build time.

| # | Change | Repository | Platforms |
| - | ------ | ---------- | --------- |
| 1 | Browse other conversations during a call, keeping the call alive via a second signaling session ([spreed#12299](https://github.com/nextcloud/spreed/issues/12299)) | spreed | all |
| 2 | Exclude the Talk window from screen capture while sharing a whole screen, so it cannot recurse into itself ([spreed#7792](https://github.com/nextcloud/spreed/issues/7792)) | talk-desktop | Windows, macOS |
| 3 | List and share minimized windows, which Chromium omits - needed for full-screen Remote Desktop windows ([talk-desktop#1788](https://github.com/nextcloud/talk-desktop/issues/1788)) | talk-desktop | Windows only |
| 4 | Release the camera when video is disabled, so its hardware light goes out ([spreed#4008](https://github.com/nextcloud/spreed/issues/4008)) | spreed | all |
| 5 | Zoom, pan and rotate images in the built-in viewer ([talk-desktop#1812](https://github.com/nextcloud/talk-desktop/pull/1812)) | talk-desktop | all |
| 6 | Let the "Do not disturb" user status silence notification banners, not only sounds and the call popup | talk-desktop | all |

Change 2 is a no-op on Linux, where `setContentProtection` is not supported.
Change 3 is Windows-only by nature: it enumerates windows through `user32` via the
`koffi` FFI module, which is packaged for `win32` only.

Talk v24.0.4 ships its own guard against the same bug
([spreed#18690](https://github.com/nextcloud/spreed/pull/18690)): a dismissible
placeholder over the local screen preview, reading "Sharing this window may cause a
mirroring effect". It only warns; change 2 actually keeps the window out of the
captured stream. On Linux the placeholder is now the only protection, which is what
change 2 always relied on. On Windows and macOS both are active, so the placeholder
covers the local preview to warn about a mirroring effect that change 2 has already
prevented.

Both stay, and the placeholder is deliberately not suppressed in the desktop build. It
is dismissible, so the cost is one click on a warning that happens to be redundant on
two of the three platforms. Hiding it would mean a fork-local patch to upstream's
`ScreenShare.vue` - a file this fork does not otherwise touch - that would have to be
carried and re-resolved on every rebase, which is more than the wart is worth.

## Branches

Both repositories use a `build/custom` integration branch. Neither is merged into
`main` - `main` stays clean so it can keep tracking upstream.

| Repository | Branch | Base | Built-in Talk |
| ---------- | ------ | ---- | ------------- |
| `vladopol/talk-desktop` | `build/custom` | upstream `v2.2.4` | - |
| `vladopol/spreed` | `build/custom` | `v24.0.4` (tag on `stable34`) | v24.0.4 |

`spreed` is built from `stable34` rather than `main`, because the desktop client's
stable channel expects Talk v24.x (see the `talk` field in `package.json`). `main`
carries an unreleased v25.0.0-dev, and the beta channel now points at v25.0.0-alpha.1.

Both branches sit on release tags rather than on branch heads, so a build is
reproducible from the tag alone. For `spreed` that means the base matches
`talk.stable` in the desktop `package.json` exactly, at the price of leaving whatever
has landed on `stable34` since the tag - 7 commits at the time of the v24.0.4 rebase.

The feature work itself lives on its own branches (`feat/screenshare-*`,
`feat/image-viewer-panzoom`, `feat/browse-during-call-*`,
`feat/release-camera-on-video-off*`) and is merged into
`build/custom`. Two of them touch the same lines of `src/main.js` and `src/preload.js`
and need a trivial manual merge: the `require('electron')` destructuring gains both
`BrowserWindow` and `nativeImage`, and the `TALK_DESKTOP` object keeps both new methods.

Upstream is deliberately unreachable: `git push origin` is disabled in both clones
(`git remote set-url --push origin DISABLED_upstream_read_only`), so only `git push fork`
can succeed. Fetching from upstream still works.

## Building

### Via GitHub Actions (all platforms)

`.github/workflows/build-custom.yml` builds all three platforms in parallel. Push a
tag starting with `build-` to start it:

```sh
git tag build-4
git push fork build-4
```

A full run takes roughly 12 minutes and uploads three artifacts: `windows-x64`
(msi + exe), `macos-universal` (dmg) and `linux-x64` (flatpak + zip).

The tag trigger exists because GitHub only registers a `workflow_dispatch` trigger
once the workflow file is on the repository default branch, which is `main` here.
The workflow also declares `workflow_dispatch` with a `spreed_ref` input, which
becomes usable if the workflow ever lands on the default branch.

### Locally

Windows distributables can only be built on Windows, and the flatpak only on Linux -
WiX, Squirrel and `flatpak-builder` have no cross-platform mode. A macOS workstation
can produce the dmg and the Linux zip, nothing else.

```sh
git clone https://github.com/vladopol/talk-desktop && cd talk-desktop
git checkout build/custom
git clone https://github.com/vladopol/spreed spreed
git -C spreed checkout build/custom
npm ci
npm ci --prefix spreed

npm run build:mac        && npm run package:mac         # dmg, on macOS
npm run build:windows:x64 && npm run package:windows:x64 # msi + exe, on Windows
npm run build:linux      && npm run package:linux        # flatpak + zip, on Linux
```

Building the Linux zip from a non-Linux host needs an explicit architecture,
otherwise it follows the host (arm64 on Apple Silicon):

```sh
./node_modules/.bin/electron-forge package --platform=linux --arch=x64
./node_modules/.bin/electron-forge make --skip-package --platform=linux --arch=x64 --targets=zip
```

Windows additionally needs the WiX Toolset v3.14 (which pulls in .NET Framework 3.5)
with `C:\Program Files (x86)\WiX Toolset v3.14\bin\` on `PATH`.

## Signing

The builds are **not** signed. That is a deliberate choice: a Windows code signing
certificate and an Apple Developer Program membership both cost money, and the build
is pinned to one version rather than shipped continuously.

What users see:

- **Windows** - SmartScreen shows "Windows protected your PC" on the installer.
  "More info" then "Run anyway" gets past it. SmartScreen keys on the file hash, so
  this reappears for every new installer, but the installed app starts silently.
- **macOS** - Gatekeeper blocks the first launch. On macOS 15 and newer the
  Control-click workaround is gone: the user must open System Settings, go to
  Privacy & Security, and press "Open Anyway". The decision sticks for that copy of
  the app.
- **Linux** - nothing. Linux has no equivalent gate.

macOS builds are still **ad-hoc signed**, by `forge.config.js`. This is not about
warnings: packaging renames the bundle and rewrites its Resources, which invalidates
the signature Electron ships with, and macOS on Apple Silicon refuses to launch a
bundle whose signature is broken. Without the ad-hoc signature the app does not start
at all. Setting `APPLE_ID`, `APPLE_ID_PASSWORD` and `APPLE_TEAM_ID` switches the same
config over to real Developer ID signing and notarization; `WINDOWS_SIGN_PARAMS` does
the same for Windows.

An ad-hoc signature must be applied **without the hardened runtime**. The hardened
runtime turns on library validation, which only lets a process load libraries signed
with its own team identifier - and an ad-hoc signature has no team identifier. The app
then dies at launch on its own Electron Framework with

```
Library not loaded: @rpath/Electron Framework.framework/Electron Framework
... mapping process and mapped file (non-platform) have different Team IDs
```

`forge.config.js` therefore passes `optionsForFile: () => ({ hardenedRuntime: false })`
for ad-hoc builds. It has to go through `optionsForFile`: `@electron/osx-sign` reads
`hardenedRuntime` only from the per-file options and silently ignores it at the top
level. Nothing is lost, since the hardened runtime is only needed for notarization,
which requires a Developer ID certificate anyway.

The app is intentionally left unbranded - no `.overrides/build.config.json`, no
version suffix. Keeping the default application IDs means the official installer
upgrades over this build in place once the changes land upstream. The flip side is
that the built-in update check still points at the official releases, so it will
eventually offer an update that drops these changes.

## Build workarounds

Three problems in the toolchain are worked around in the workflow. All three were
found by a failing build, and each one should be reconsidered rather than kept
forever.

**`macos-alias` and Node 24.** The dmg maker reaches `appdmg` → `ds-store` →
`macos-alias`, which calls `util.isDate()` - one of the legacy `util.is*` helpers Node
removed in v23. `macos-alias` has been unmaintained since 2017, so the workflow
patches the call site after `npm ci`. The patch fails loudly if the call ever
disappears. Note that preloading a shim through `NODE_OPTIONS` does *not* work on
GitHub runners: setting `NODE_OPTIONS` via `$GITHUB_ENV` is refused outright. This
goes away if upstream replaces `appdmg`.

**Missing SVG loader for the flatpak icon.** `flatpak build-export` validates
application icons through gdk-pixbuf. The Ubuntu runner has no SVG loader, so the
scalable icon is rejected with `is not a valid icon: Format not recognized`. Fixed by
installing `librsvg2-common`. Not fork-specific - worth reporting upstream.

**WiX Toolset.** Not guaranteed to be present on the Windows runner image, so the
workflow installs it if `candle.exe` is missing. Also not fork-specific.

The flatpak target runs with `continue-on-error` so that a flatpak failure still lets
the working zip reach the artifacts, and with `DEBUG` set, because
`@malept/flatpak-bundler` otherwise swallows all `flatpak-builder` output and reports
only an exit code. A following step then fails the job explicitly - without it a job
that produced no flatpak would still report success.

## Rebuilding on a newer upstream release

1. Fetch upstream in both clones, tags included.
2. Branch a backup off each `build/custom` before touching it, named after the base it
   still sits on (`backup/build-custom-v223`, `backup/build-custom-v2403`).
3. Rebase `build/custom` onto the new tag in both clones. The desktop branch sits on a
   tag, so `git rebase v2.2.4` is enough; the `spreed` branch sits on a `stable34`
   commit, so it needs `git rebase --onto v24.0.4 <old base> build/custom`.
4. Check that the `spreed` base still matches the `talk` field in the desktop
   `package.json`.
5. Reinstall and run the checks below, then push both branches and a new `build-*` tag.

Rebasing `build/custom` directly leaves the feature branches on the old base. That is
fine as long as they are not merged in again. If one is still being worked on, rebase it
too and recreate `build/custom` from it - and expect the known self-conflict between the
screensharing branches in `src/main.js` and `src/preload.js`, where the
`require('electron')` destructuring has to keep both `BrowserWindow` and `nativeImage`
and the `TALK_DESKTOP` object both new methods.

Re-run `npm ci` in both clones after switching branches - the Talk version, and with it
the dependency set, changes between bases.

What the v2.2.4 / v24.0.4 rebase actually cost, as a calibration point: the desktop
branch replayed all 24 commits without a single conflict, because that release changed
no source file at all. `spreed` conflicted on five commits, four of them over nothing
but an import line in `src/App.vue` or `src/views/MainView.vue`, against upstream's new
`hasExternalCallService` import. The fifth was real but small: upstream added an
external-call teardown to the same `if` in `App.vue` that change 1 guards with
`!skipLeavingPreviousConversation`, and the teardown belongs inside that guard, since it
should only run when the conversation is actually being left.

Things to check on every rebase, learned from the v2.2.3 and v2.2.4 ones:

- **Has upstream fixed something a patch here works around?** v2.2.3 fixed the Sass BOM
  that corrupted extracted styles by pinning `postcss@8.5.23`; this fork carried its own
  fix for the same bug (`sassOptions.charset: false` in `webpack.renderer.config.js`) and
  dropped it on the rebase. Duplicated fixes are cheap to keep and expensive to explain
  later, so drop ours whenever upstream covers the same failure - after confirming the
  upstream fix actually holds on this branch, not just in the changelog. The overlap can
  also be partial: Talk v24.0.4 addressed the same bug as change 2 with a weaker fix, so
  both stayed, and what needs deciding is whether upstream's warning still makes sense
  next to ours.
- **Did a fork commit land upstream?** The `spreed` branch carried
  `chore: update update-nextcloud-openapi workflow`, which was backported into stable34
  and arrived in v24.0.4. The rebase dropped it silently, as it should. Count the commits
  on both sides of a rebase and account for every one that disappears.
- **Are the fork-local Russian strings still there?** Change 6 adds two settings whose
  labels upstream does not know about, so their `ru` translations were written by hand in
  `l10n/ru.js` and `l10n/ru.json`. Those files are regenerated from Transifex upstream and
  the two entries disappear on a rebase - the settings then show up in English.
- **Do the linters still pass?** The rebase pulls in a new dependency tree, and stylistic
  rules can get stricter without any upstream code change. `npm run lint` and
  `npm run ts:check` in both clones before tagging; the fixes belong in the commit that
  introduced the code, not in a trailing "lint" commit. `ts:check` is the one that finds
  things: the v24.0.4 rebase caught three type errors in the `#1777` debug commits, all
  from `@total-typescript/ts-reset` handing back `unknown` where the code assumed a type
  (`JSON.parse`, and the reason of a rejected promise). None were new - they had simply
  never been checked.
- **`npm test` in `spreed` does not run on Node 25.** Every one of the 79 test files dies
  in setup with `localStorage.getItem is not a function`, and a pristine `v24.0.4`
  worktree fails exactly the same way, so it is the toolchain and not the fork. Confirm
  that on the upstream tag before spending time on it, and use an older Node if the suite
  is actually needed.

## Verifying a build

Neither the installers nor the packaged apps are verified automatically. At minimum,
before handing a build out:

- install it on a clean machine of the target platform,
- start a call and confirm changes 1, 2 and 4,
- confirm change 3 on Windows, where it is the only place it is active.

Inspecting the artifacts is not a substitute for launching them. A macOS build that
passed `codesign --verify --deep --strict` still died at launch, because that command
checks signature integrity and says nothing about whether the process is allowed to
load its own libraries. The cheapest check that would have caught it is starting the
binary:

```sh
"Nextcloud Talk.app/Contents/MacOS/Nextcloud Talk"
```

If it survives a few seconds and spawns helper processes, the framework loaded.

File inspection is still useful as a first pass, just never as the last one:

```sh
codesign -dvvv "Nextcloud Talk.app"                             # expects: adhoc, and no `runtime` flag
lipo -archs "Nextcloud Talk.app/Contents/MacOS/Nextcloud Talk"  # expects: x86_64 arm64
```

Two things that file inspection cannot tell you either:

- **Windows** - whether `koffi` actually loads. It is copied into the package by the
  `packageAfterCopy` hook and unpacked from the asar archive; if that goes wrong,
  change 3 breaks at runtime. Open the screen sharing picker and look for minimized
  windows.
- **Linux (zip)** - whether `chrome-sandbox` works. A zip does not preserve the setuid
  bit, so the app may refuse to start with "The SUID sandbox helper binary was found,
  but is not configured correctly". Either `sudo chown root:root chrome-sandbox &&
  sudo chmod 4755 chrome-sandbox`, or run with `--no-sandbox`. The flatpak is not
  affected - zypak handles it.
