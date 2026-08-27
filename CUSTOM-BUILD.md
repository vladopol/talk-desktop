<!--
  - SPDX-FileCopyrightText: 2026 Vladimir Poluliashenko
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Custom build

This fork carries eight changes that are not in upstream Nextcloud Talk Desktop yet, and
builds unsigned distributables for Windows, macOS and Linux from them.

The list is meant to shrink. Every change here is a patch to re-resolve on every
rebase, so whenever upstream covers the same ground its version wins, even when ours
is better - the goal is to end up on a stock build, not to maintain a better fork.

Everything here is specific to the fork. Nothing in this document applies to
[nextcloud/talk-desktop](https://github.com/nextcloud/talk-desktop).

## What is in the build

Three of the changes live in the desktop client, five in the built-in Talk (`spreed`),
which is bundled into the app at build time.

| # | Change | Repository | Platforms |
| - | ------ | ---------- | --------- |
| 1 | Browse other conversations during a call, keeping the call alive via a second signaling session ([spreed#12299](https://github.com/nextcloud/spreed/issues/12299)) | spreed | all |
| 2 | List and share minimized windows, which Chromium omits - needed for full-screen Remote Desktop windows ([talk-desktop#1788](https://github.com/nextcloud/talk-desktop/issues/1788)) | talk-desktop | Windows only |
| 3 | Release the camera when video is disabled, so its hardware light goes out ([spreed#4008](https://github.com/nextcloud/spreed/issues/4008)) | spreed | all |
| 4 | Zoom, pan and rotate images in the built-in viewer ([talk-desktop#1812](https://github.com/nextcloud/talk-desktop/pull/1812)) | talk-desktop | all |
| 5 | Let the "Do not disturb" user status silence notification banners, not only sounds and the call popup | talk-desktop | all |
| 6 | Release the joined-conversation watcher when it fires synchronously on registration, so it cannot place an outgoing call nobody asked for ([talk-desktop#1777](https://github.com/nextcloud/talk-desktop/issues/1777)) | spreed | all |
| 7 | Keep the participant stripe as the user set it when following a participant, instead of collapsing it ([spreed#19162](https://github.com/nextcloud/spreed/issues/19162)) | spreed | all |
| 8 | Keep the mirroring warning of [spreed#18690](https://github.com/nextcloud/spreed/pull/18690) out of the small call overlay, where it spills over the controls | spreed | all |

Change 2 is Windows-only by nature: it enumerates windows through `user32` via the
`koffi` FFI module, which is packaged for `win32` only.

### What change 1 has to keep

Change 1 is the largest patch here and the only one that rearranges the app's layout, so
it is also the one that has broken in the field. Every rule below started as a bug report
with a screenshot, and every one of them is easy to undo by accident when re-resolving the
patch on a rebase. They live in `CallView.vue`, `ViewerOverlayCallView.vue`, `MainView.vue`
and `ScreenShare.vue` in `spreed`.

- **A call view whose conversation is not the viewed one is always the compact overlay.**
  That is decided from the token in `CallView`, deliberately not from the `isViewerOverlay`
  flag of the call view store: the flag belongs to the viewer, which clears it whenever a
  file is closed - including a file opened in the browsed conversation - and the call view
  would then expand to full size on top of the chat.
- **The overlay is anchored to the bottom of the messages, not of the call container.**
  While another conversation is browsed that container spans the whole chat, so its bottom
  is the message input: the overlay's collapse button landed exactly on the send button. It
  also observes the messages, which shrink as the input grows, so it follows a message that
  spans several lines.
- **It stays on top of the viewer and goes under dialogs.** Upstream's `z-index: 11000`
  is there for the viewer, which the overlay was made to float over. Nothing else
  layered over a browsed conversation should be covered by the call, so with the viewer
  closed the overlay drops below the dialog layer (the modal mask is at 9998) and is back
  as soon as the dialog is gone. A dialog and a floating call cannot both be uncovered:
  the dialog wins, because it is modal and transient.
- **It is rendered next to the whole main view**, outside the branch a lobby replaces.
  Otherwise browsing a conversation whose lobby blocks the user takes the call off the
  screen entirely - still running, with no way to see it or to leave it.
- **Whatever a watcher sets up has to be seeded when the call view is created.** The call
  view is created again during an ongoing call, on the way back from a browsed
  conversation, so a watcher that only fires on changes never sees what was already true.
  The shared screens are the case that bit: without them the big area falls back to the
  promoted video, which renders the screen inside itself along with its own bottom bar, and
  the presenter's name, the media indicators and "Stop following" end up drawn twice, over
  each other. State the previous call view leaves behind needs the same care in the other
  direction - the "start without media" default is consumed once per call rather than on
  every mount, and the `RemoteVideoBlocker`s are destroyed unblocked.
- **A small screen preview does not carry the mirroring placeholder.** It is a full size
  empty content with a description and two buttons: in the overlay, at most 400px wide, it
  does not fit and spills over the overlay's own controls. Only the big screen shows it,
  where it can be read and where the mirroring it warns about is what the user is looking
  at.

### Dropped: screen capture protection

The fork used to carry a sixth change, excluding the Talk window from OS screen capture
via `BrowserWindow.setContentProtection` while a whole screen was shared, so the capture
could not recurse into itself ([spreed#7792](https://github.com/nextcloud/spreed/issues/7792)).
Talk v24.0.4 shipped its own answer to the same bug
([spreed#18690](https://github.com/nextcloud/spreed/pull/18690)): a dismissible
placeholder over the local screen preview, reading "Sharing this window may cause a
mirroring effect".

Ours prevented where upstream's only warns, and dismissing the placeholder brings the
recursion back - but upstream's is the better solution regardless, on two counts our
version could not answer:

- **It covers all three platforms.** `setContentProtection` is a no-op on Linux, so a
  third of the users never got the fix at all. The placeholder is plain Vue and works
  everywhere.
- **It keeps the presenter and the viewers looking at the same thing.** Cutting the
  window out of the capture creates a mismatch that has bitten in practice: the
  presenter points at the chat window on their screen and the viewers see the desktop
  behind it, with no idea what is being pointed at. Hiding a window only from the
  audience is surprising in a way a placeholder is not.

So this is not a fork giving up a better patch to shrink - it is a worse patch being
replaced. Where ours is genuinely stronger is narrow: `Dismiss` reinstates the bug, and
in Electron the placeholder also appears when sharing a single window, where mirroring
cannot happen (upstream skips it only for `displaySurface === 'browser'`, which Electron
never reports). Neither is worth carrying a patch for.

The work is kept on `feat/screenshare-content-protection`, which is no longer merged
into `build/custom`. It was last built into `build-14`.

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

The feature work itself lives on its own branches (`feat/screenshare-minimized-windows`,
`feat/image-viewer-panzoom`, `feat/browse-during-call-*`,
`feat/release-camera-on-video-off*`) and is merged into `build/custom`.
`feat/screenshare-content-protection` is the exception: it is kept but no longer merged,
see above. While both screensharing branches were in, they collided in `src/main.js` and
`src/preload.js` over the `require('electron')` destructuring and the `TALK_DESKTOP`
object; with only one of them left there is nothing to resolve.

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
scripts/refresh-talk-l10n.sh spreed   # the workflow does this on its own
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

### Translations of the built-in Talk

`scripts/refresh-talk-l10n.sh` replaces `l10n/` in the `spreed` clone with the one from
upstream `stable34`, and the build workflow runs it right after checking the fork out.

The reason is that the `spreed` branch sits on a release tag while translations keep
landing in the branch that tag was cut from for months afterwards: at the v24.0.4 tag the
Russian catalogue was 49 strings behind what upstream had already translated, and the
whole set of languages 4700 lines behind. Nothing in this fork translates Talk itself, so
there is nothing to merge - upstream's catalogue is simply the better one.

Writing such a string by hand is the trap this replaces. The two labels of the mirroring
warning were translated here on 27.08 and reverted the same day: upstream had already
translated both with different wording, so the hand-written pair would have collided on
the next rebase and the label would have changed under the users.

What it costs: a `build-*` tag no longer pins the build completely. Only `l10n/` moves -
the code of both repositories stays pinned to the tag - and the workflow log records the
upstream commit the catalogue came from.

The desktop client's own `l10n/` is not touched by any of this. It carries two
hand-written Russian strings that upstream will never have, because they belong to
change 5, which exists only here.

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
  be partial and still count: Talk v24.0.4 answered the same bug as the old change 2 with
  a weaker fix, and ours was dropped regardless, because carrying a better patch forever
  costs more than the difference is worth. "Ours is better" is not a reason to keep it.
- **Did a fork commit land upstream?** The `spreed` branch carried
  `chore: update update-nextcloud-openapi workflow`, which was backported into stable34
  and arrived in v24.0.4. The rebase dropped it silently, as it should. Count the commits
  on both sides of a rebase and account for every one that disappears.
- **Are the fork-local Russian strings still there?** Change 5 adds two settings whose
  labels upstream does not know about, so their `ru` translations were written by hand in
  the desktop `l10n/ru.js` and `l10n/ru.json`. Those files are regenerated from Transifex
  upstream and the two entries disappear on a rebase - the settings then show up in
  English. This applies to the desktop repository only: the translations of the built-in
  Talk are taken from upstream at build time, see above.
- **Do the linters still pass?** The rebase pulls in a new dependency tree, and stylistic
  rules can get stricter without any upstream code change. `npm run lint` and
  `npm run ts:check` in both clones before tagging; the fixes belong in the commit that
  introduced the code, not in a trailing "lint" commit. `ts:check` is the one that finds
  things: the v24.0.4 rebase caught three type errors in the `#1777` debug commits, all
  from `@total-typescript/ts-reset` handing back `unknown` where the code assumed a type
  (`JSON.parse`, and the reason of a rejected promise). None were new - they had simply
  never been checked.
- **`npm test` in `spreed` needs a flag on Node 25.** Without it every test file dies in
  setup with `localStorage.getItem is not a function`: Node 25 ships its own Web Storage
  and its `localStorage` throws unless a backing file is given, which shadows the one of
  jsdom. A pristine `v24.0.4` worktree fails the same way, so it is the toolchain and not
  the fork. Point it at a scratch file and the whole suite passes:

  ```sh
  NODE_OPTIONS="--localstorage-file=$(mktemp -u)" npm test -- run
  ```

  Use a **fresh** file per run - the storage is a real database that survives the run, and
  a suite that reads what a previous run wrote fails (`settings.spec.js` does). Its lock is
  also shared by the parallel workers, so a run can die with `database is locked`; that one
  is a flake, re-run it.

## Verifying a build

Neither the installers nor the packaged apps are verified automatically. At minimum,
before handing a build out:

- install it on a clean machine of the target platform,
- start a call and confirm changes 1 and 3,
- confirm change 2 on Windows, where it is the only place it is active.

Change 1 is worth walking through with a screen share running, as that is where it has
broken so far: share a screen, browse another conversation, open a file and a dialog
there, browse a conversation with a lobby, and come back to the call. Nothing may end up
drawn twice or on top of the message input, and the call overlay has to stay reachable
the whole time.

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
  change 2 breaks at runtime. Open the screen sharing picker and look for minimized
  windows.
- **Linux (zip)** - whether `chrome-sandbox` works. A zip does not preserve the setuid
  bit, so the app may refuse to start with "The SUID sandbox helper binary was found,
  but is not configured correctly". Either `sudo chown root:root chrome-sandbox &&
  sudo chmod 4755 chrome-sandbox`, or run with `--no-sandbox`. The flatpak is not
  affected - zypak handles it.
