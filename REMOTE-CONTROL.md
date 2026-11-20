<!--
  - SPDX-FileCopyrightText: 2026 Vladimir Poluliashenko
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Remote control during screen sharing

**Status: planned, not implemented.** Nothing of it exists in this fork or upstream yet.
This document is the implementation reference: the design, the facts it rests on (each with
the file or source it was checked against), the platform APIs, the open questions for the
prototype and the test plan. The Russian version of the plan lives in the team's operations
notes as §19.166 (revision 2, 2026-11-20); the two describe the same design.

Like everything in [CUSTOM-BUILD.md](CUSTOM-BUILD.md), this is specific to the fork.

## Contents

- [Goal and scope](#goal-and-scope)
- [Constraints that cannot be worked around](#constraints-that-cannot-be-worked-around)
- [Which shares can be controlled](#which-shares-can-be-controlled)
- [Architecture](#architecture)
- [Signaling channel](#signaling-channel)
- [Protocol](#protocol)
- [Checks on the presenter side](#checks-on-the-presenter-side)
- [Controller side](#controller-side)
- [Injecting input into the OS](#injecting-input-into-the-os)
- [Sharing a window](#sharing-a-window)
- [Shared clipboard](#shared-clipboard)
- [Security and presenter priority](#security-and-presenter-priority)
- [User interface](#user-interface)
- [Packaging](#packaging)
- [Existing code the feature builds on](#existing-code-the-feature-builds-on)
- [Implementation status](#implementation-status)
- [Test builds and debugging](#test-builds-and-debugging)
- [Testing log](#testing-log)
- [Open questions for the prototype](#open-questions-for-the-prototype)
- [Stages and estimate](#stages-and-estimate)
- [Test plan](#test-plan)
- [Maintenance](#maintenance)

## Goal and scope

A participant who shares a screen or a window (the **presenter**) lets another participant of
the call (the **controller**) drive their mouse and keyboard, and exchange text with them
through the clipboard. Everything happens inside the Talk call: no third-party software, no
second video stream, no extra server.

**v1:**

- presenter: Talk Desktop on Windows, macOS and Linux on X11;
- controller: Talk Desktop on any platform;
- sources: all screens (`entire-desktop`), one screen, one window;
- input: absolute mouse with all buttons, wheel, physical keys;
- clipboard: plain text in both directions.

**Not in v1:** the controller in a browser (needs a server-side component, see
[Packaging](#packaging)), a Linux presenter on Wayland (needs the RemoteDesktop portal, with a
system dialog for every session), HTML, images and files in the clipboard, several controllers taking turns, chat
messages about granted control, a server-side policy of who may control, a P2P data channel
for mouse moves, tracking the presenter's local keyboard (low-level hooks), raising an
occluded window automatically on Windows.

Decisions taken from how others do it:

| System | What it does | Taken from it |
|---|---|---|
| Kontur.Talk, Zoom, MS Teams | Only the desktop client gives control; consent every time, a visible "being controlled" banner, take back in one click | Desktop-only presenter, consent, banner, instant revoke |
| TeamViewer, RDP, RustDesk | Keys travel as physical scan codes; everything pressed is released on disconnect; text clipboard is synchronised (RDP: rdpclip) | Scan codes, release-all, text clipboard |
| Jitsi Meet Electron | Had remote control via robotjs and removed it: a native module was too costly to maintain | Keep the input layer minimal, no new native module |
| Zoom | Remote input is paused while the presenter moves their own mouse | Local input wins |

## Constraints that cannot be worked around

- **A browser cannot inject input into the OS.** Only Talk Desktop can give control.
- **In v1 only Talk Desktop can take control too.** The web UI is the stock spreed app installed
  on the server from the app store, which has no remote-control module. Controlling from a
  browser needs a server-side component, which is v2.
- **Both sides need a build with the module.** The fleet is mixed: on 2026-11-20 the fork ran on
  39 of 47 desktop installations, but only 4 of them were on the latest build and 16 still on
  2.2.4. The button only appears between two clients that both announce support (`hello`, see
  [Protocol](#protocol)); a pilot starts with installing the new build for its participants.
- **Windows UIPI.** No input can be injected into windows running at a higher integrity level
  than Talk: UAC prompts, an elevated Task Manager, installers. `SendInput` then silently does
  nothing. Ctrl+Alt+Del, Win+L and the secure desktop are out of reach, and the secure desktop
  is black in the capture anyway. Talk is never run elevated for this.
- **macOS needs the Accessibility permission, and the fork loses it with every build.** The
  builds are ad-hoc signed (`osxSign: { identity: '-' }` in `forge.config.js`, see
  [CUSTOM-BUILD.md](CUSTOM-BUILD.md#signing)), and TCC records the grant against the code
  directory hash of that exact build. After installing a new `build-N` the old entry in System
  Settings still shows as enabled but no longer applies: the user has to remove it with "−" and
  add the app again. The UI has to say so. There is one Mac in the fleet, which is why the macOS
  presenter is a stage that can wait.
- **Sharing a window does not show its menus and dialogs** (expected, to be confirmed by the
  prototype). Window capture (Windows Graphics Capture, ScreenCaptureKit on macOS) captures the
  window itself only. Context menus, drop-down lists, tooltips and separate dialogs are windows
  of their own, so the controller does not see them. See [Sharing a window](#sharing-a-window).
- **The signaling server (HPB) limits message size and nothing else.** Checked against
  `strukturag/nextcloud-spreed-signaling` master; production runs build `2e544f8`, which is older,
  but the constant below has not changed in years:
  - `client/client.go`: `maxMessageSize = 64 * 1024`, applied by `conn.SetReadLimit(maxMessageSize)`;
  - `server/hub.go`, `processMessageMsg`: a `message` to a session is delivered whenever the
    recipient is on the same backend (`sess.Backend().Id() != session.Backend().Id()` is the only
    check). **There is no same-room check**, so any session of any user of the server can address
    the presenter's session;
  - no permission check for plain messages, no rate limiting on the message path;
  - `sender.sessionid` (and `sender.userid`) are always filled in by the server from the
    authenticated session and cannot be forged by the client;
  - `control` messages need `PERMISSION_MAY_CONTROL` (`isAllowedToControl`), i.e. a moderator.
- **Latency** is whatever signaling plus video take. Unnoticeable on the LAN, noticeable over the
  VPN. The prototype has to measure the actual frame rate of the share in `webrtc-internals`:
  with a low frame rate control feels sluggish however fast the signaling is.

## Which shares can be controlled

The source type is visible in the `sourceId` the screensharing dialog of Talk Desktop returns
(`src/talk/renderer/screensharing/DesktopMediaSourceDialog.vue`; the type is
`ScreensharingSourceId` in `screensharing.types.ts`).

| sourceId | Where it exists | The rectangle the frame maps to | What input is allowed |
|---|---|---|---|
| `entire-desktop:0:0` ("Audio + All screens") | Windows only. The dialog does not offer it on macOS and Wayland (`DesktopMediaSourceDialog.vue:92`) | The whole virtual desktop, in physical pixels | Everything except the holes between monitors of different sizes: a point on no monitor (`MonitorFromPoint(pt, MONITOR_DEFAULTTONULL)` returns null) is dropped |
| `screen:<id>:0` | Windows, macOS | One monitor | Everything on that monitor |
| `window:<id>:0` | Windows (`id` = HWND), macOS (`id` = CGWindowID) | The window, its position read again for every event | The window, its menus and its dialogs only |
| anything on Wayland | Linux | — | No control button |

The constraints spreed passes for each (`.overrides/spreed/src/utils/webrtc/simplewebrtc/getscreenmedia.js:24`):
`entire-desktop` is captured with `chromeMediaSource: 'desktop'` and no source id (plus desktop
audio), everything else with `chromeMediaSourceId: sourceId`. No size or frame-rate limits are
set, so Chromium's defaults for desktop capture apply.

Minimized windows (change 2 of the fork, talk-desktop#1788) are picked like any other window:
they are restored before capture (`app:activateWindowForCapture`, `src/main.js:220`) and keep
their `sourceId`.

## Architecture

```
 Controller (Talk Desktop)                     HPB (signaling)              Presenter (Talk Desktop)
 ┌──────────────────────────────┐                                       ┌──────────────────────────────────┐
 │ spreed: layer over the screen │ ── message{to: sessionid} ──►   ──►  │ spreed connector → RemoteControlHost│
 │ <video>, RemoteControlClient  │ ◄──── state / hb / clip ───────  ◄── │   checks, limits, clipboard        │
 │ main: key capture             │      sender.sessionid / .userid      │        │ IPC (contextBridge)        │
 │   (before-input-event),       │      are set by the server           │ main: session state, watchdogs,    │
 │   clipboard                   │                                      │   InputInjector (koffi):           │
 └──────────────────────────────┘                                       │   Win SendInput / mac CGEvent      │
                                                                        │   consent window, banner, log      │
                                                                        └──────────────────────────────────┘
```

The renderer never touches the OS. Session state lives in the **main process**, which re-checks
every request: a compromised renderer cannot get input injected without the local user's
consent.

### Shape: a module with a thin connector, not a plugin

- **A Nextcloud app** that injects JS into the Talk page does not work where it matters most:
  Talk Desktop runs its **built-in** spreed frontend and loads no scripts of server apps. Only
  the desktop can give control, so a server app would only ever cover the controller in a
  browser. spreed also has no public JS API for a call: `OCA.Talk` exposes `instance`,
  `Settings`, message actions and participant search, but not the signaling, the call
  participants or the screen elements. Such an app would have to reach into Vue and Pinia
  internals and would break silently on every Talk update.
- **A Talk Desktop plugin.** Talk Desktop has no plugin system, and OS input lives in the main
  process, which the build has to carry anyway.

So: **all code in `src/remote-control/` of Talk Desktop, plus a small connector in
`.overrides/spreed`** (tens of lines, no translatable strings). When the module is missing or
disabled, the connector does nothing. On a rebase only the connector has to be carried over.
The same connector could later be proposed upstream as a public API (`OCA.Talk.call.*`), after
which the browser side could become a regular Nextcloud app.

The connector follows the existing integration: Talk Desktop already provides
`window.OCA.Talk.Desktop` (`src/shared/globals/globals.js:89`, currently `{ getDesktopMediaSource }`)
and spreed calls it behind `IS_DESKTOP`. The module adds `OCA.Talk.Desktop.remoteControl`, and the
connector in spreed calls it when it exists.

**What the connector gives the module:**

- the **call's** signaling object (`emit('message', …)`, `on('message', …)`), not the browse
  session of change 1 (`src/utils/webrtc/browseSignaling.js`), plus `fromUserId` taken from
  `sender.userid` (one line in the Standalone `case 'message'`, `src/utils/signaling.js:805`);
- the call participants: `inCall`, `actorType`, `actorId`, `sessionId`;
- start and end of the local screen share, with its `sourceId`. This is more reliable than
  wrapping `getUserMedia` as the indicator draft does: the picker's live previews call
  `getUserMedia` with the same constraints, and the draft has to opt them out by hand;
- in `ScreenShare.vue`: a reference to the `<video>`, pausing panzoom and the double-click zoom,
  hiding `VideoBottomBar`, a mount point for the control layer;
- mount points for buttons in the screen-share menu and the participant menu.

**Proposed module layout** (names are a suggestion):

| File | Process | Content |
|---|---|---|
| `src/remote-control/protocol.ts` | shared | Message types, schema validation, limits |
| `src/remote-control/keymap.ts` | shared | `KeyboardEvent.code` → Windows scan code / macOS `kVK_*`, whitelist, blacklist |
| `src/remote-control/session.main.ts` | main | Session state machine, watchdogs, revoke triggers, IPC handlers |
| `src/remote-control/geometry.main.ts` | main | Source rectangle per mode, letterboxing, point → OS coordinates |
| `src/remote-control/injector.win.ts` | main | koffi bindings: `SendInput`, hit testing, foreground checks |
| `src/remote-control/injector.mac.ts` | main | koffi bindings: CGEvent, CGWindowList |
| `src/remote-control/clipboard.main.ts` | main | Monitoring, attribution, sensitive formats, chunk assembly |
| `src/remote-control/consent.window.ts` | main | Consent and confirmation windows |
| `src/remote-control/log.main.ts` | main | `remote-control.log`, rotation |
| `src/remote-control/host.ts` | renderer | Presenter: receive, check, forward to main |
| `src/remote-control/client.ts` | renderer | Controller: capture, coalesce, send |
| `src/remote-control/components/*.vue` | renderer | Control layer, toolbar, menu entries, hints |

The banner extends the screensharing indicator (`src/app/screenshareIndicator.window.ts`, see
[Existing code](#existing-code-the-feature-builds-on)). The preload API is a narrow
`TALK_DESKTOP.remoteControl` object (`src/preload.js:21`):
`move(x, y)`, `button(b, d, n)`, `wheel(dx, dy)`, `key(code, d)`, `releaseAll()`, `clip(text)`,
plus requests for the consent window and session state events. Everything goes through one
ordered channel (`ipcRenderer.send`), and main executes it strictly in order.

## Signaling channel

The same mechanism spreed uses for "is typing…" (`src/utils/SignalingTypingHandler.js:62`):
`signaling.emit('message', { type, to: signalingSessionId })`. The Standalone signaling wraps it
as `{ type: 'message', message: { recipient: { type: 'session', sessionid }, data } }`
(`sendCallMessage`, `src/utils/signaling.js:949`). The receiving side sets `from` to
`sender.sessionid`, which the **server** filled in (`signaling.js:805`). All authentication rests
on that.

- **Not the `control` type**: HPB only relays it from moderators, and anyone may be the controller.
- **`sender.userid` is server-set too**, but spreed drops it. The connector keeps it as
  `fromUserId`. The login shown to the presenter comes from there, not from the participant
  list. An empty `fromUserId` is a guest and is rejected.
- **HPB does not check the recipient's room.** The first check of any `rc` message, before any UI
  is shown, is that `from` is in this call right now.
- **Queued messages are replayed.** `doSend` (`signaling.js:994`) pushes messages to
  `pendingMessages` while the socket is not connected (`signaling.js:998`), and they are all sent
  at once after reconnecting (`signaling.js:1159`). For input this means old clicks and keys
  arriving seconds late. The module sends no `rc` while `signaling.connected` is false: events
  are dropped, and a `rel` goes out after reconnecting.
- Internal signaling (without HPB) is not supported; production always has HPB.
- The messages travel over a WebSocket on TCP, so ordering is guaranteed: key presses and
  releases are neither lost nor reordered, and a clipboard transfer arrives before the key press
  that pastes it.
- **Possible later improvement:** a separate P2P `RTCDataChannel` (unordered,
  `maxRetransmits: 0`) for mouse moves only, over the existing TURN server. Only if measurements
  over the VPN show signaling is not good enough.
- Change 1 of the fork keeps a **second** signaling session for browsing other conversations
  during a call. Control messages are sent and accepted **only in the call's session**, anything
  arriving in the browse session is ignored.
- **Stock clients ignore `rc`.** `webrtc.js:573` and `simplewebrtc.js:67` have no branch for
  unknown types, and `Peer.prototype.handleMessage` (`peer.js:532`) does nothing with them. Note
  that while the local user is not in the call, the handler in `webrtc.js` rewrites
  `message.type` to `'message-to-ignore'`, so the module must read the type before that handler
  runs or from a copy.

## Protocol

Every message is `{ type: 'rc', v: 1, op, sid, seq, t, … }`:

- `sid` — random session id (16 bytes, base64url), created by the presenter when granting;
- `seq` — strictly increasing per sender;
- `t` — the sender's `performance.now()` in ms, used to drop late events.

| op | From → to | Fields | Meaning |
|---|---|---|---|
| `hello` | anyone → call participants | `roles` (`host`, `ctl`), `os` (`win`/`mac`/`linux`) | The client supports the feature. Sent on joining the call and to everyone who joins later |
| `cap` | presenter → call participants | `src` (`desktop`/`screen`/`window`), `ok`, `why` | Whether the current share can be controlled. Sent when sharing starts, stops or changes, and to late joiners |
| `offer` | presenter → controller | `sid`, `src`, `os`, `clip` | The presenter offers control |
| `request` | controller → presenter | — | The controller asks for control; the presenter confirms |
| `accept` / `decline` | answer to `offer`/`request` | `sid`, `why` (`user`, `timeout`, `busy`, `disabled`) | Consent or refusal |
| `frame` | controller → presenter | `w`, `h` | Size of the frame the controller sees (`videoWidth`/`videoHeight`); at start and on every `resize` of the video |
| `ptr` | controller → presenter | `x`, `y` ∈ [0, 1] | Absolute cursor position in the frame |
| `btn` | controller → presenter | `b` (0 left, 1 middle, 2 right, 3 back, 4 forward), `d` (down/up), `x`, `y`, `n` (click count, `event.detail`) | A mouse button, with its position so the click lands exactly |
| `wheel` | controller → presenter | `dx`, `dy` in 1/120 of a notch, at most ±1200 per message | Scrolling, including smooth touchpad scrolling |
| `key` | controller → presenter | `code` (`KeyboardEvent.code`), `d` | A physical key |
| `rel` | controller → presenter | — | Release everything held: the layer lost focus, the window was minimised, the connection came back |
| `clip` | both ways | `cid`, `i`, `n`, `data` (a part of the text, at most 16 KiB of UTF-8) | Clipboard, see [Shared clipboard](#shared-clipboard) |
| `hb` | both ways | — | Heartbeat, once per second |
| `state` | presenter → controller | `s`: `active`/`paused`/`blocked`, `why` | Pause or block: `local-input`, `window-hidden`, `window-occluded`, `focus-elsewhere`, `hb-lost` |
| `revoke` | either → the other | `sid`, `why` | End of the session |

### Session states (presenter, kept in main)

```
idle ──request/offer──► consent ──accept──► active ◄──► paused (local-input, hb-lost, window-hidden)
  ▲                        │                  │  ▲
  │                     decline/timeout       │  └──► blocked (window-occluded, focus-elsewhere; per event)
  └────────────── revoke (any trigger, see Security) ◄─────────┘
```

Every transition out of `active` calls `releaseAll()`.

### Timers and limits

| What | Value |
|---|---|
| Heartbeat interval | 1 s, both ways |
| No heartbeat → pause and `releaseAll()` | 3 s |
| No heartbeat → revoke | 15 s |
| Renderer → main ping; none → pause and `releaseAll()` | 1 s / 3 s |
| Consent window: buttons enabled after / auto-decline after | 1 s / 30 s |
| Pause after local mouse movement | 1.5 s after the **last** local movement (sliding) |
| Local cursor poll | 100 ms, threshold a few pixels |
| Controller mouse moves | at most 60/s, by timer |
| Accepted `ptr` / other input | ≤ 70/s / ≤ 50/s, more → `revoke`, `why: 'flood'` |
| `request` per participant | 1 per 10 s; after 3 declines in a row auto-declined for the rest of the call |
| Event older than the best known clock offset by | 1 s → dropped |
| Clipboard: per copy / per part / parts per copy / copies | 256 KB / 16 KiB / 16 / 1 per s |
| Clipboard: incomplete transfer dropped after | 2 s |
| Clipboard: change attributed to the controller within | 2 s after their copy shortcut or click |
| Clipboard poll on the presenter | 250 ms (Windows sequence number), 500 ms (macOS hash) |
| Window rectangle cache | 50 ms for moves, fresh for buttons |
| Frame vs window aspect mismatch that blocks clicks | > 2 % |

### Rules

- **The mouse is absolute and normalised.** The controller computes `x, y` relative to the
  *content* of the `<video>`: `object-fit: contain` (bars top/bottom or left/right),
  `videoWidth`/`videoHeight` and CSS transforms. Upstream `ScreenShare.vue` has its own zoom
  (panzoom, `ScreenShare.vue:142`), so the content rectangle is taken from
  `getBoundingClientRect()` of the transformed video. The scale is uniform, so the maths holds at
  any zoom. Clicks on the bars are not sent; a drag leaving the frame is clamped to [0, 1].
  Stream scaling, simulcast and codec losses do not affect precision.
- **Letterboxing inside the frame itself** is handled by the presenter: the aspect ratio from
  `frame` is compared with the source rectangle. This matters for a window being resized. When
  they differ by more than 2 % (the window is being dragged), clicks are not executed, moves are.
- **Moves are coalesced** to at most 60 per second by timer, sending only the latest position.
  Not by `requestAnimationFrame`: on a 144 Hz monitor that yields 144 per second, and the limit
  would revoke the session. Buttons, keys and the wheel are sent immediately, never coalesced.
- **Keys travel as `code`, not `key`.** The presenter's keyboard layout applies (like the
  scan-code mode of RDP), so Russian/English works without translating characters; switching
  the layout is the presenter's Alt+Shift or Win+Space. Auto-repeat is generated by the
  presenter's OS, so repeated `keydown`s (`repeat: true`) are not sent. On a Windows controller
  AltGr arrives as a fake ControlLeft right before AltRight; the fake one is not sent.
- **Modifiers across operating systems.** When the two sides run different OSes (`os`), Cmd
  becomes Ctrl and back in shortcuts with a letter or a digit; otherwise Cmd+C from a Mac
  arrives on Windows as Win+C. A toolbar toggle controls it, on by default. Shortcuts without a
  letter (Ctrl+Tab) pass unchanged. Copy and paste shortcuts are recognised after the mapping.

## Checks on the presenter side

An `rc` message is executed only if **all** of these hold:

1. The `from` session is in this call now (`inCall` from the participant events) and is a
   Nextcloud user (actorType `users`) whose `actorId` equals `fromUserId`. Guests, federated
   users, SIP participants and the recording session are not offered and are rejected. This
   check comes **first, before any window is shown**: HPB delivers from any session of the server.
2. A session is active, `sid` matches, `from` is the session control was granted to.
3. The presenter still shares the same source as when granting (same `sourceId`, window still exists).
4. `seq` is greater than the last accepted one (stale `ptr`s are dropped). Fields are validated
   against the schema: coordinates clamped to [0, 1], `code` from the whitelist (letters, digits,
   F1–F24, navigation, modifiers, numpad). Anything else is dropped and logged.
5. The event is not late. Each `hb` records the offset between the controller's `t` and the local
   clock, and the minimum is kept. An event whose offset exceeds the minimum by more than 1 s is
   dropped. A burst of old input after a reconnect is therefore never executed, even if the
   controller did send it.
6. Rate limits from the table above.
7. `request` rate per participant from the table above.

## Controller side

- **Keyboard capture (desktop).** While the layer is active, main intercepts every key in
  `webContents.on('before-input-event')`, calls `preventDefault()` and hands `input.code` to the
  module. That way Ctrl+W, Ctrl+R, F5, F11, F12, Alt and Ctrl+Tab reach the presenter, and none of
  Talk Desktop's own handlers fire:
  - Alt+←/→ and Cmd+[/] would navigate the Talk window back (`src/app/applyBackForwardNavigation.ts:14`);
  - Ctrl+0/=/− are menu accelerators for the zoom (`src/app/app.menu.js:76`);
  - the call hotkeys of spreed: M microphone (`LocalAudioControlButton.vue:330`), Space
    push-to-talk (`:331`), V camera (`LocalVideoControlButton.vue:238`), R raise hand
    (`ReactionMenu.vue:43`). The page receives no keys at all, so they cannot fire.

  The OS does not hand over Alt+Tab, Win, Cmd+Tab, Cmd+Space, Ctrl+Alt+Del or Win+L; a hint says
  so. The Keyboard Lock API is only needed for a browser controller (v2).
- **Mouse.** `setPointerCapture` on press, so the release arrives even if the pointer left the
  layer. `contextmenu` is suppressed, otherwise Talk's own context menu (`applyContextMenu`,
  `src/talk/talk.window.js:81`) appears. The back/forward mouse buttons are suppressed on
  `mouseup`, otherwise Chromium navigates the Talk window back. On `blur`, `visibilitychange` and
  `lostpointercapture` a `rel` is sent. The local cursor stays visible over the layer: the remote
  cursor arrives with the video latency, and it is hard to aim with it alone.
- **Wheel.** `deltaMode` 0 (pixels), 1 (lines) and 2 (pages) are converted to 1/120 notch units:
  one notch is about 100 px in Chromium on Windows, less on macOS, so the factor is per platform.
  Deltas are accumulated and sent with the move coalescing. A pinch on a touchpad arrives as a
  wheel event with `ctrlKey` set while Ctrl is not held; drop those unless Ctrl is actually down.
- **Only on the big screen.** When the call shrinks to the compact overlay (change 1, browsing
  another conversation) or another video becomes the big one, nothing is sent (this is not a
  revoke), with a hint "Return to the screen share".

## Injecting input into the OS

Only the main process injects. Every injected point goes through the same pipeline: normalised
frame coordinates → letterbox correction → source rectangle → OS coordinates → hit test → inject.

### Windows

`koffi` is already a dependency (change 2, `src/app/nativeWindows.ts`), so no new native module
is needed. `getBindings()` (`nativeWindows.ts:87`) shows the binding style to follow: lazy,
`__stdcall`, handles as `uintptr_t`, a null result on any failure.

Electron runs per-monitor DPI aware (v2), so `GetSystemMetrics`, window rectangles from DWM and
monitor rectangles are all in **physical pixels**. Electron's DIPs never enter the computation,
except to locate a monitor once.

**Source rectangle:**

- `entire-desktop` — the virtual desktop: `GetSystemMetrics(SM_XVIRTUALSCREEN = 76,
  SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79)`. The full-desktop
  capture covers the same bounding rectangle, so normalised frame coordinates map straight onto
  0…65535.
- `screen:` — source → `display_id` from `desktopCapturer.getSources()` → the Electron `Display`
  (the indicator draft does this in `resolveIndicatedDisplays`, `screenshareIndicator.window.ts:133`)
  → the centre of `display.bounds` through `screen.dipToScreenPoint()` → `MonitorFromPoint` →
  `GetMonitorInfoW().rcMonitor`. The OS gives the exact physical rectangle, rather than
  recomputing scale factors of 125 or 150 %. If no monitor is found, control is unavailable.
  **The indicator's fallback of outlining every display is fine for a border, never for input.**
- `window:` — see [Sharing a window](#sharing-a-window).

**Mouse:** `SendInput` with `INPUT_MOUSE`.

| Constant | Value |
|---|---|
| `INPUT_MOUSE`, `INPUT_KEYBOARD` | 0, 1 |
| `MOUSEEVENTF_MOVE` | 0x0001 |
| `MOUSEEVENTF_LEFTDOWN` / `LEFTUP` | 0x0002 / 0x0004 |
| `MOUSEEVENTF_RIGHTDOWN` / `RIGHTUP` | 0x0008 / 0x0010 |
| `MOUSEEVENTF_MIDDLEDOWN` / `MIDDLEUP` | 0x0020 / 0x0040 |
| `MOUSEEVENTF_XDOWN` / `XUP` (`mouseData` = `XBUTTON1` 1 / `XBUTTON2` 2) | 0x0080 / 0x0100 |
| `MOUSEEVENTF_WHEEL` / `HWHEEL` (`mouseData` = delta, `WHEEL_DELTA` = 120) | 0x0800 / 0x1000 |
| `MOUSEEVENTF_VIRTUALDESK` | 0x4000 |
| `MOUSEEVENTF_ABSOLUTE` | 0x8000 |

- Moves: `MOVE | ABSOLUTE | VIRTUALDESK`, with `dx = round((x − vx) × 65535 / (vw − 1))` and the
  same for `dy`. Check corner pixels for ±1 px rounding.
- Wheel deltas need not be multiples of 120; fractional notches keep touchpad scrolling smooth.
- `INPUT` is a union: `DWORD type` + `MOUSEINPUT` (`LONG dx, dy; DWORD mouseData, dwFlags, time;
  ULONG_PTR dwExtraInfo`) or `KEYBDINPUT` (`WORD wVk, wScan; DWORD dwFlags, time; ULONG_PTR
  dwExtraInfo`). `sizeof(INPUT)` is 40 on x64. With a wrong `cbSize` `SendInput` returns 0 and
  does nothing.
- Under UIPI `SendInput` fails silently; its return value is not a reliable signal.

**Hit test before every button and wheel event, in every mode:** `WindowFromPoint` →
`GetAncestor(hwnd, GA_ROOT = 2)`. If the window belongs to Talk itself
(`GetWindowThreadProcessId` equals `process.pid`), the event is not injected. The exception is
the click-through strips of the indicator border: they must be skipped and whatever is under
them tested instead. Otherwise clicks in the outermost 4 px of the screen are rejected, which
is exactly where the Start corner and the bottom edge of the taskbar are.

**Keyboard:** `KEYEVENTF_SCANCODE` (0x0008) with `wVk = 0`, plus `KEYEVENTF_EXTENDEDKEY` (0x0001)
for the E0-prefixed keys (arrows, Ins/Del/Home/End, PgUp/PgDn, right Ctrl/Alt, Win, numpad Enter
and ÷), `KEYEVENTF_KEYUP` (0x0002) for releases. The system translates the scan code with the
foreground thread's layout. Pause (E1 1D 45) needs special handling or goes to the blacklist.

### macOS

`koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')`
(CoreGraphics and HIServices), plus CoreFoundation for the window list.

| Constant | Value |
|---|---|
| `kCGEventSourceStatePrivate` / `CombinedSessionState` / `HIDSystemState` | −1 / 0 / 1 |
| `kCGHIDEventTap` | 0 |
| `kCGEventLeftMouseDown` / `Up` / `Dragged` | 1 / 2 / 6 |
| `kCGEventRightMouseDown` / `Up` / `Dragged` | 3 / 4 / 7 |
| `kCGEventMouseMoved` | 5 |
| `kCGEventKeyDown` / `KeyUp` / `FlagsChanged` | 10 / 11 / 12 |
| `kCGEventScrollWheel` | 22 |
| `kCGEventOtherMouseDown` / `Up` / `Dragged` | 25 / 26 / 27 |
| `CGMouseButton` left / right / centre | 0 / 1 / 2 (DOM right is 2, CG right is 1) |
| Event field `kCGMouseEventClickState` | 1 |
| `kCGScrollEventUnitPixel` / `Line` | 0 / 1 |
| Flags: AlphaShift, Shift, Control, Alternate, Command, NumericPad, SecondaryFn | 0x10000, 0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x800000 |

- **Event source:** `CGEventSourceCreate(kCGEventSourceStatePrivate)` and
  `CGEventSourceSetLocalEventsSuppressionInterval(source, 0)`. By default macOS suppresses local
  hardware mouse events for 0.25 s after each synthetic event, and the presenter could never take
  the mouse back.
- Moves and buttons: `CGEventCreateMouseEvent(source, type, CGPoint, button)` (the point is passed
  by value) + `CGEventPost(kCGHIDEventTap, event)` + `CFRelease`. Coordinates are points in the
  global display space, the same space as Electron's `display.bounds`.
- **Drag:** while a button is held, moves must be `…MouseDragged` of that button, not
  `kCGEventMouseMoved`, or selection and drag-and-drop do not work.
- **Double click:** Cocoa only recognises it through `kCGMouseEventClickState`
  (`CGEventSetIntegerValueField(event, 1, n)` on both down and up). Without it a double click in
  Finder turns into two single clicks.
- Scrolling: `CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitPixel, 2, dy, dx, 0)`
  (the non-variadic variant).
- Keys: `CGEventCreateKeyboardEvent(source, kVK, down)`, with `CGEventSetFlags` set on every event
  from the tracked modifier state.
- Permission: `CGPreflightPostEventAccess()` (macOS 10.15+) or
  `systemPreferences.isTrustedAccessibilityClient(false)` before offering control;
  `CGRequestPostEventAccess()` or `isTrustedAccessibilityClient(true)` shows the system prompt.
  Without the permission the "Give control" button is disabled with a hint that also explains the
  per-build loss of the grant.
- Own windows are filtered by `kCGWindowOwnerPID == process.pid`.

### Linux (X11)

`libX11.so.6` and `libXtst.so.6` through koffi (`src/remote-control/injector.linux.ts`); both
are dependencies of Electron itself, so they are present wherever Talk runs, the flatpak
runtime included (the flatpak has `--socket=fallback-x11`).

- Coordinates are physical pixels of the root window: `screen.dipToScreenRect()` for a screen,
  `XDisplayWidth`/`XDisplayHeight` for `entire-desktop`, `XGetGeometry` +
  `XTranslateCoordinates` for a window (`window:<XID>:0`).
- `XTestFakeMotionEvent`, `XTestFakeButtonEvent` (buttons 1/2/3, back 8, forward 9; the wheel is
  buttons 4–7, one press per notch, fractions carried over), `XTestFakeKeyEvent` with the
  keycode evdev + 8 from the key table. The X server applies the presenter's layout.
- Hit test: the window manager's `_NET_CLIENT_LIST_STACKING` from the top, skipping
  `_NET_WM_STATE_HIDDEN` and the indicator strips; own windows by `_NET_WM_PID`; dialogs by the
  `WM_TRANSIENT_FOR` chain; menus are override-redirect windows outside the client list, so the
  shared window is the top client under them. Keys: `_NET_ACTIVE_WINDOW`.
- An X error handler that ignores errors is installed first: a `BadWindow` on a window that has
  just been closed would otherwise end the process in Xlib's default handler.
- Password managers: `x-kde-passwordManagerHint` (KeePassXC, Klipper).
- **Wayland:** XTest only reaches XWayland windows, so a Wayland session reports
  `cap: { ok: false, why: 'wayland' }` and the controller sees why.

### Key table

Do not write the `code` → scan code / `kVK` table by hand. Chromium's
`ui/events/keycodes/dom/dom_code_data.inc` has exactly this table: each
`DOM_CODE(usb, evdev, xkb, win, mac, code, id)` row maps the DOM `code` string to the Windows scan
code (E0-prefixed keys as `0xe0XX`), the macOS `kVK_*` and the Linux evdev code. Generate
`keymap.ts` from it once, keep the source revision and the BSD licence notice in the file header
(and in `REUSE.toml`), and keep only the whitelisted keys.

### Releasing keys is mandatory

The injector remembers every key and button it pressed. A release without a matching press is
ignored (the key was held before the layer had focus). On **any** end of a session (revoke,
pause, lost heartbeat, `rel`, leaving the call, end of the share, closed window, exception in the
injector, `before-quit`) `releaseAll()` sends key-up and button-up for everything remembered.
Otherwise Ctrl or a mouse button stays stuck down on the presenter's machine.

## Sharing a window

A window is harder than a screen: a screen is entirely in the frame, a window only shows itself,
while on the real screen anything may lie on top of it.

- **Window rectangle.** Windows: `DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS = 9)`,
  the visible frame in physical pixels, without the invisible resize borders (`GetWindowRect`
  includes about 7 px extra left, right and bottom on Windows 10/11). macOS:
  `CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow = 8, windowId)` → `kCGWindowBounds`
  (points), `kCGWindowOwnerPID`, `kCGWindowLayer`, `kCGWindowIsOnscreen`. Cached for 50 ms for moves,
  read fresh for buttons. That the captured frame matches this rectangle at the corners is not
  documented for Windows Graphics Capture or the GDI capturer. Verify it on a normal, maximised and
  snapped window on Windows 10 and 11.
- **What counts as "this window" for a click (Windows).** `WindowFromPoint` → `GetAncestor(GA_ROOT)`.
  The click goes through if that is the shared window, or a window whose owner chain
  (`GetWindow(hwnd, GW_OWNER = 4)`) leads to it (dialogs, popups of Chromium and Electron apps),
  or a menu (class `#32768`) or caption-less popup (`GWL_STYLE = −16` has `WS_POPUP = 0x80000000`
  without `WS_CAPTION = 0x00C00000`) on the same UI thread.
  **Not by PID:** browsers, Office and Explorer keep many top-level windows in one process, and a
  PID check would let a blind click into another document lying on top of the shared one. In UWP
  apps the frame belongs to ApplicationFrameHost and the content to the app itself, which the
  HWND-based check survives and a PID check does not.
- **The same on macOS.** On-screen windows are walked front to back
  (`CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly = 1, 0)`), skipping our own. The
  first one containing the point must be the shared window, or a window of the same PID with a
  layer above 0 (menus, popovers), or its sheet.
- **Occluded window.** If someone else's window is at the point, the click is not injected:
  `state: blocked, why: window-occluded`, and the controller sees "The window is covered on the
  presenter's screen". The presenter's banner offers "Bring to front": clicking it makes Talk the
  foreground process, and `SetForegroundWindow` is then allowed. On macOS the Accessibility
  permission also allows raising automatically (`AXUIElementPerformAction(…, kAXRaiseAction)`),
  which the pilot can decide on.
- **Keyboard (Windows).** `GetForegroundWindow()` → `GetAncestor(GA_ROOTOWNER = 3)` must be the
  shared window, which lets its own dialogs through even outside the frame, or one of its menus.
  Otherwise keys are dropped with `state: blocked, why: focus-elsewhere` and the hint "Click into
  the window". Without this rule the controller would type into the presenter's messenger
  without seeing it. macOS: the frontmost application has the window's PID, and its topmost
  layer-0 window is the shared one or a sheet over it.
- **Session start.** At the moment of consent Talk is in the foreground: the presenter just
  clicked its consent window. `SetForegroundWindow` is therefore allowed: a minimised window is
  restored (`restoreNativeWindow`, `nativeWindows.ts:354`) and brought to the front.
- **Window states.**
  - Minimised (`IsIconic`, `kCGWindowIsOnscreen` false) or on another virtual desktop
    (`DWMWA_CLOAKED = 14`, another Space) → `paused`, `window-hidden`, with "Restore" on the banner.
  - Closed (`IsWindow` false, gone from the window list) → `revoke`.
  - Moved to a monitor with another scale factor needs no special handling: the rectangle is
    read in physical pixels on every event.
- **Menus and dialogs are not visible** (see [Constraints](#constraints-that-cannot-be-worked-around)).
  If the prototype confirms it, the controller sees a permanent hint in window mode: "Menus and
  dialogs of this application are not visible to you; ask to share the screen for full control".
  The presenter's consent window says the same. When a window of that application outside the
  frame becomes active, the controller additionally sees "The presenter has a window open that is
  not shared".
- **The title bar is in the frame**, so the controller can move, maximise and close the window.
  Closing ends the share and the session, which is acceptable.
- **A full-screen Remote Desktop window (mstsc)** is the main use case of change 2. Injected keys
  go to mstsc and on into the remote session (Ctrl+Alt+End there is Ctrl+Alt+Del). Win shortcuts
  depend on mstsc's "Apply Windows key combinations" setting. The clipboard reaches the remote
  session through rdpclip when clipboard redirection is on. Verify in the pilot.

## Shared clipboard

v1: plain text (`text/plain`) only, both directions, at most 256 KB per copy (configurable).
Text is split into parts of 16 KiB of UTF-8: HPB accepts at most 64 KiB per message including the
JSON envelope, and Cyrillic plus JSON escaping inflate text. No images, HTML/RTF or files.
Enabled by a "Shared clipboard (text)" checkbox in the consent window, checked by default, and
globally by a Talk Desktop setting.

**Controller → presenter (paste):**

- Desktop controller: main sees the paste shortcut (Ctrl+V, Shift+Insert, Cmd+V, after modifier
  mapping) in `before-input-event`, reads `clipboard.readText()` itself, the module sends `clip`,
  then the keys. The renderer only gets the clipboard content after a physical paste shortcut on
  the active layer. Without a paste the controller's clipboard goes nowhere: it may hold their own
  passwords.
- A "Send clipboard" toolbar button covers pasting through a context menu of the remote application.
- Presenter: parts are assembled, and on the last one main calls `clipboard.writeText()`. Ordering
  is strict (WebSocket → one IPC queue → main), so the key after `clip` pastes the new text. An
  incomplete transfer (parts missing for 2 s) is dropped.
- Line endings are converted to the presenter's OS (CRLF on Windows); NUL characters are removed.
- The presenter's previous clipboard content is lost and not restored, as in TeamViewer. On
  Windows the pasted text also ends up in the clipboard history (Win+V), a known limitation.

**Presenter → controller (copy):**

- The clipboard is watched only during an active session: on Windows `GetClipboardSequenceNumber()`
  (user32) every 250 ms, which is cheap and reads no content until the number changes; on macOS a
  hash of `clipboard.readText()` every 500 ms.
- Only a change made by the controller is sent: it happened within 2 s after a copy shortcut they
  injected (Ctrl+C/X, Ctrl+Insert, Shift+Delete, Cmd+C/X) or a click they injected (a "Copy" menu
  item), and there was no local input since (the session was not paused). What was in the
  clipboard before the session started is never sent.
- **Passwords are never sent.** Password managers mark their entries. On Windows these are the
  registered formats `ExcludeClipboardContentFromMonitorProcessing`, `Clipboard Viewer Ignore`,
  and `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` set to a DWORD 0. On macOS
  these are `org.nspasteboard.ConcealedType`, `org.nspasteboard.TransientType` and
  `org.nspasteboard.AutoGeneratedType`. Check with `clipboard.has()`; if Electron does not see
  them, check through koffi (`RegisterClipboardFormatW` + `IsClipboardFormatAvailable`).
- Echo suppression: text just written from a `clip` is not sent back (by hash).
- Desktop controller: main calls `clipboard.writeText()`, only while a session is active and
  within the limit, and shows "Copied from <name>'s computer".
- Browser controller (v2):
  - paste: use the `paste` event and its `clipboardData`, which need no permission. Do not
    `preventDefault()` the paste `keydown`; keep a focused hidden `textarea` as the event target;
    hold the V key until `paste` arrives (≤ 150 ms);
  - copy: in the `keydown` handler of the copy shortcut, call
    `navigator.clipboard.write([new ClipboardItem({ 'text/plain': promise })])` synchronously,
    and resolve the promise when the `clip` arrives. Safari requires a user gesture and Firefox
    a recent activation; a button is the fallback.
- The presenter's banner shows "Clipboard: 1.2 KB of text → <name>" for a few seconds. The log
  records the size, never the content.

## Security and presenter priority

- **Consent every time**, no "remember". The consent window is drawn by the main process in a
  window of its own, not by spreed in the shared window. Main confirms **both** a `request` and
  the presenter's own `offer`: the menu entry in spreed only asks main to show "Give control to
  Ivanov (ivanov)? [Give] [Cancel]". An XSS in the renderer therefore cannot grant control without
  a click.
- **The consent window** shows:
  - the display name and the **login** from `fromUserId`, not just the display name, which users
    set for themselves;
  - what will be controlled ("Screen 2", "Window: Contract.docx — Word");
  - the clipboard checkbox.

  Its buttons are enabled 1 s after it appears, focus is on "Decline", and Enter does not accept:
  the window pops up under the cursor of someone who is busy clicking. It declines on its own
  after 30 s. At most one consent window exists at a time; other requests get `decline: busy`.
  While a session runs, new `request`s are declined automatically.
- **One controller** per session, and at most one session per controller. A presenter who is
  being controlled cannot control anyone. A new session gets a new `sid`.
- **A banner over all windows**: "Controlled by <name> · [Take back]", with a border of another
  colour, plus "[Bring to front]" / "[Restore]" in window mode. It builds on the screensharing
  indicator, which is not in the build yet (see [Existing code](#existing-code-the-feature-builds-on)).
- **Instant revoke:**
  - "Take back" on the banner and in the call;
  - a global shortcut `Ctrl+Alt+Shift+Esc` (`globalShortcut`). The injector never sends it, it is
    on the `code` blacklist, because on Windows `RegisterHotKey` also fires on injected input.
    If `register` returns `false` (the shortcut is taken), the consent window says so;
  - automatically:
    - the share ends or switches to another source, the shared window is closed;
    - either side leaves the call;
    - the screen locks (`powerMonitor` `lock-screen`), the system suspends (`suspend`);
    - the renderer crashes or reloads (`render-process-gone`, navigation).
- **Local input wins.** The injector remembers where it last put the cursor. If the cursor
  position (`screen.getCursorScreenPoint()`, polled every 100 ms) has moved more than a few pixels
  away from it, the presenter moved the mouse. Remote input then pauses until 1.5 s after the
  **last** local movement (`state: paused`, the controller sees "The presenter took over the
  mouse"). This is how Zoom does it; low-level hooks (`LLMHF_INJECTED`) are not needed. On macOS
  this only works with the suppression interval set to 0 (see [macOS](#macos)). The local
  keyboard is not tracked in v1.
- **Watchdogs, both ways and between processes:**
  - presenter: no `hb` for 3 s — pause and `releaseAll()`; for 15 s — revoke;
  - controller: no `hb`/`state` from the presenter for 3 s — "Connection lost", nothing is sent;
  - presenter's main: the renderer pings main every second; no ping for 3 s (the renderer hung
    with a key held) — pause and `releaseAll()`.
- **Talk's own windows are not controlled.** Clicks and the wheel over any Talk Desktop window
  (the consent window, the banner, the call) are not injected. **Keys are dropped while a Talk
  window is in the foreground**: otherwise injected M, V and Space would switch the presenter's
  microphone and camera through spreed's hotkeys, and text would end up in the chat. The
  controller cannot press "Take back" or grant themselves anything.
- **Log.** Talk Desktop has no file log at all, only the console. The module gets its own
  `remote-control.log` in `app.getPath('logs')`, with rotation. It records grants, revokes with
  their reason, failed checks and the sizes of clipboard transfers. Keys and clipboard content
  are never logged: they contain passwords.
- **Kill switches:** a Talk Desktop setting "Allow giving control" (on by default), a separate
  "Shared clipboard" setting, and a build config flag that disables the whole feature with one
  rebuild.
- **Limit of the protection.** Main guarantees one thing: the local user consented and can take
  control back at any moment. A compromised renderer can fake the name in the consent window,
  since name and login reach main through it. Accepted.

## User interface

**Presenter:**

- *Planned, not in the prototype:* "Give control…" in the screen-share menu and the participant
  menu, listing the Nextcloud users in the call who sent `hello` with the `ctl` role.
- An incoming request opens main's consent window (`RemoteControlConsent.vue`): an icon, "Request
  to control your computer", the display name and the login, one sentence saying what will be
  controlled (the shared screen, all screens, or the window "…"), the revoke shortcut, note cards
  for a taken shortcut and for window mode, the clipboard checkbox, then "Decline" (focused) and
  "Allow" (enabled after 1 s). It takes the height of its content and declines on its own after 30 s.
- During a session: the banner at the top of the screen under the cursor (`RemoteControlBanner.vue`)
  - "Controlled by Name (login)" or the reason of a pause, "Bring to front" in window mode, "Take
  back". It takes the width of its content and can be dragged aside.
- Settings → "Screen sharing": "Allow giving control of a shared screen" and "Shared clipboard
  (text) while controlled"; on macOS the description explains the Accessibility permission and
  its loss with every build.

**Controller:**

- "Request control" is an icon button in the **call's bottom bar, after the reactions**
  (`RemoteControlCallButton.vue`, mounted by spreed's `BottomBar.vue`). It is about the screen
  share shown big: it appears when that presenter runs a build with the module (`hello` with the
  `host` role) and shares something (`cap.src`). With `ok: false` it is disabled and its tooltip
  says why (macOS without the permission, Wayland, disabled in the settings); the reason, a
  decline or a timeout is also shown in the top right corner of the screen share. During a
  session the same button is highlighted and stops control. Nothing is shown for the small tiles,
  the participant stripe or the compact call overlay of change 1.
- While waiting: "Waiting for the presenter to allow control …"; a decline or a timeout is shown
  next to the button.
- During an active session, a layer over the `<video>` in `ScreenShare.vue`:
  - upstream's panzoom is paused (`instance.pause()`) and the double-click zoom is disabled (the
    `@dblclick.capture` handler on the container, `ScreenShare.vue:10` and `:168`). The wheel,
    double clicks and drags go to the presenter. A zoom set before the session is kept: small text
    on a large screen is easier to read that way;
  - `VideoBottomBar` (`ScreenShare.vue:42`) is hidden: it lies on the bottom edge of the frame,
    exactly where the presenter's taskbar is;
  - an outline around the video (orange; red while the layer has the keyboard focus) and a
    toolbar: "Stop control", "Send clipboard", "Use Cmd as Ctrl" / "Use Ctrl as Cmd" (when the OSes
    differ), state hints. Keys are captured only while the layer has the focus ("Click on the
    screen to type"), so the chat next to the call stays usable;
  - in window mode a permanent hint that menus and dialogs are not visible;
- while `paused`/`blocked`: a hint with the reason, nothing is sent. A refused click keeps its
  reason on screen for at least 3 s.

**Strings live only in Talk Desktop's l10n** (`talk_desktop`, Russian written by hand, as for
change 5). The spreed connector has no strings at all: `scripts/refresh-talk-l10n.sh` replaces
spreed's `l10n/` with upstream's on every build (`git checkout FETCH_HEAD -- l10n`), and any
fork string there would show untranslated.

## Packaging

- **koffi is packaged for Windows, macOS and Linux.** The `packageAfterCopy` hook in
  `forge.config.js` copies `node_modules/koffi` into the package, keeping only the prebuilt of the
  target (`win32_<arch>`, `linux_<arch>`). The universal macOS app is merged from an x64 and an
  arm64 build, so **both** `darwin_x64` and `darwin_arm64` go into **both** halves, and
  `packagerConfig.osxUniversal.x64ArchFiles: '**/node_modules/koffi/build/koffi/**'` tells
  `@electron/universal` that these identical single-architecture files are intended (without it
  the merge fails). `asar.unpack` covers `**/node_modules/koffi/**`. Verified in `build-rc-1`:
  `lipo -archs` gives `x86_64` and `arm64` for the two `.node` files, the bundle is ad-hoc signed,
  the Linux zip carries `linux_x64/koffi.node`.
- **Electron fuses** (v2.3.4+): `OnlyLoadAppFromAsar` and embedded asar integrity are on. koffi is
  unpacked and has been proven to load on Windows by change 2; on macOS the injector has been
  loaded from source in Electron, the packaged app still has to prove it with a real session.
- **TCC on macOS:** see [Constraints](#constraints-that-cannot-be-worked-around). The user guide
  needs a step "after installing a new build: System Settings → Privacy & Security →
  Accessibility → remove Nextcloud Talk with '−', add it again".
- **A controller in a browser** (v2) needs code on the server: either a Nextcloud app that injects
  the controller side into the web UI (fragile, see the connector rationale above), or the
  connector upstreamed as a public API.

## Existing code the feature builds on

Talk Desktop (`build/custom`):

| Where | What it is | Relevance |
|---|---|---|
| `src/shared/globals/globals.js:89` | `OCA.Talk.Desktop = { getDesktopMediaSource }` | Where `remoteControl` is exposed to spreed |
| `src/preload.js:21` | `TALK_DESKTOP` object | Where the narrow preload API goes |
| `src/main.js:97`, `:167`, `:220` | `parseHwndFromSourceId`, `app:getDesktopCapturerSources`, `app:activateWindowForCapture` | sourceId formats, restoring minimised windows |
| `src/app/nativeWindows.ts:87`, `:354` | koffi bindings, `restoreNativeWindow` | Binding style, restore + foreground |
| `src/talk/renderer/screensharing/DesktopMediaSourceDialog.vue:92` | Source list per platform | `entire-desktop` only on Windows |
| `src/talk/renderer/screensharing/screensharing.types.ts` | `ScreensharingSourceId` | sourceId type |
| `src/app/applyBackForwardNavigation.ts:14` | Alt+←/→, Cmd+[/] in `before-input-event` | Must be suppressed on the controller |
| `src/talk/talk.window.js:81` | `applyContextMenu(window)` | Must be suppressed on the controller |
| `src/app/app.menu.js:76` | Zoom accelerators | Must be suppressed on the controller |
| `forge.config.js:178`, `:242`, `:274` | koffi copy hook, asar unpack, ad-hoc signing | macOS packaging |
| `scripts/refresh-talk-l10n.sh` | Replaces spreed's `l10n/` | No strings in the connector |

**The screensharing indicator** (`src/app/screenshareIndicator.window.ts`,
`src/talk/renderer/screensharing/screenshareIndicator.ts`) was restored from the draft kept in
`stash@{0}` and is the first commit of `feat/remote-control`. The stash itself was not dropped.
Since `build-rc-4` the border is 1 px, and on Windows the strips are created with
`thickFrame: false` and clipped with `setShape`: frameless windows there keep the caption style,
whose minimum height made the top strip some 30-40 px thick (see
[Testing log](#testing-log)). What
control takes from it:

- four click-through strips per display (`getBorderBounds`, `:58`), which the hit test has to
  see through;
- `display_id` → `Display` mapping (`resolveIndicatedDisplays`, `:133`), without the
  all-displays fallback;
- the window to extend with the banner (`setScreenshareIndicator`, `:218`).

spreed (`.overrides/spreed`, `build/custom` on v25.0.8):

| Where | What it is | Relevance |
|---|---|---|
| `src/utils/signaling.js:805` | `data.message.data.from = data.message.sender.sessionid` | Server-set sender; add `fromUserId` next to it |
| `src/utils/signaling.js:949` | `Signaling.Standalone.prototype.sendCallMessage` | How `emit('message')` is wrapped |
| `src/utils/signaling.js:994`, `:998`, `:1159` | `doSend`, `pendingMessages` push, flush on connect | Replay after reconnect |
| `src/utils/webrtc/webrtc.js:573` | Call message handler, `'message-to-ignore'` | Unknown types ignored; type rewritten when not in call |
| `src/utils/webrtc/simplewebrtc/simplewebrtc.js:67`, `peer.js:532` | Message dispatch | Unknown types ignored |
| `src/utils/SignalingTypingHandler.js:62` | Typing over signaling messages | Pattern to follow |
| `src/utils/webrtc/browseSignaling.js` | Second session of change 1 | Ignore `rc` there |
| `src/utils/webrtc/simplewebrtc/getscreenmedia.js:24` | Desktop capture constraints | No size/fps limits set |
| `src/components/CallView/shared/ScreenShare.vue:10`, `:42`, `:142`, `:168` | Double-click zoom, `VideoBottomBar`, panzoom | Pause/hide during control |
| `src/components/CallView/shared/LocalAudioControlButton.vue:330`, `LocalVideoControlButton.vue:238`, `src/components/TopBar/ReactionMenu.vue:43` | Call hotkeys M, Space, V, R | Never let injected or captured keys trigger them |

## Implementation status

On branch `feat/remote-control` of both forks (2026-11-20). First live session between a
Windows presenter and a macOS controller on 2026-11-20, see [Testing log](#testing-log).

| Part of the plan | State |
|---|---|
| Indicator (change 6) | Restored from the stash, committed first |
| Protocol, checks, limits, watchdogs, `releaseAll`, revoke triggers, log | Done |
| Windows injector, window mode (owner chain, focus rule, states, "Bring to front") | Done; window mode works on Windows (`build-rc-6`) |
| macOS injector (CGEvent, CGWindowList, Accessibility) | Done; window list and hit test checked on a Mac, injection not yet |
| Linux X11 injector | Done, untested; Wayland not supported |
| Clipboard both ways, attribution, password-manager formats | Done |
| Consent window, banner, control layer, key capture, Cmd ↔ Ctrl, settings, kill switch, ru strings | Done; consent window and banner reworked after the first test (`build-rc-3`) |
| "Request control" in the call's bottom bar | Done (`build-rc-6`), works; moved next to the screen share button with its own tooltip in `build-rc-7` |
| Clients getting to know each other (`hello`/`cap`) whatever the order of joining | Fixed in `build-rc-5`, confirmed with `build-rc-6` |
| koffi in the universal macOS build and on Linux | Done |
| Presenter **offering** control (screen-share and participant menus) | Not done: only the controller's request, to keep the spreed connector small |
| "Take back" inside the call window | Not done: the banner and the shortcut cover it |
| Cmd ↔ Ctrl only in shortcuts with a letter or digit | Simplified: the modifier is mapped as a whole while the toggle is on |
| Raising an occluded window on macOS and Linux | Not done, left to the pilot as planned |
| Measurements, the open questions below, pilot | Pending |

## Test builds and debugging

**Branches.** The prototype lives on `feat/remote-control` in both forks, `build/custom` and the
`build-N` numbering are untouched. On the talk-desktop branch the last commit,
`ci: build the remote control test branch with its spreed branch`, makes the workflow bundle
spreed from `feat/remote-control` instead of `build/custom` (`SPREED_REF`). **Drop that commit when
the branch is merged into `build/custom`.**

**Test builds** are started by `build-rc-N` tags, so they never collide with release builds:

```sh
git tag build-rc-5 && git push fork build-rc-5
gh run download <run id> --repo vladopol/talk-desktop --dir out/build-rc-5
```

| Tag | Contents | State |
|---|---|---|
| `build-rc-1` | Indicator, remote control (Windows, macOS, Linux X11), docs | Built, tested 2026-11-20 |
| `build-rc-2` | + the reason of a refused click stays visible for 3 s | Built |
| `build-rc-3` | + consent window and banner reworked, 1 px border | Cancelled in favour of rc-4 |
| `build-rc-4` | + border thin on Windows (`thickFrame: false`, `setShape`) | Built (macOS job lost to GitHub runner capacity; dmg built locally) |
| `build-rc-5` | + every first `hello` answered, early `cap` kept, layer waits for the module | Cancelled in favour of rc-6 |
| `build-rc-6` | + "Request control" moved to the call's bottom bar | Built in CI on all platforms (run 44758087728), plus a local dmg; tested 2026-11-20 |
| `build-rc-7` | + banner no longer grows, name without login; button next to screen share, own tooltip | Built in CI on all platforms (run 44789199830); consent window spread wide on Windows |
| `build-rc-8` | + consent window and banner keep the size requested | Current |

GitHub-hosted macOS runners are sometimes short: on 2026-11-20 the macOS job of `build-rc-4` was
cancelled after 15 minutes in the queue ("The job was not acquired by Runner of type hosted"), and
`build-rc-6` waited as a whole. Nothing is wrong with the code then; `gh run rerun <id> --failed`
retries only that job. Meanwhile the dmg is built locally from the same commit and kept apart from
the CI artifacts:

```sh
CHANNEL=stable npm run build:mac && CHANNEL=stable npm run package:mac
mkdir -p out/build-rc-N/macos-universal-local
cp out/make/dmg/universal/Nextcloud.Talk-macos-universal.dmg out/build-rc-N/macos-universal-local/
```

The local spreed clone has to be on `feat/remote-control` for that (the log line
`Packaged with built-in Nextcloud Talk v… on path:` ends in `.overrides/spreed`).

Locally (macOS) the dmg and the Linux zip build as in [CUSTOM-BUILD.md](CUSTOM-BUILD.md#locally),
with `CHANNEL=stable`: while HEAD carries a `build-*` tag, the dev channel fails in
`getFullVersion` (`webpack.renderer.config.js`), which expects a tag `v<package version>`. The same
applies to `npm run dev`.

**Reading a packaged client.** Talk Desktop has no file log of its own:

- the renderer console goes to stderr with `--enable-logging=stderr`:
  `"/Applications/Nextcloud Talk.app/Contents/MacOS/Nextcloud Talk" --enable-logging=stderr > talk.log 2>&1`
  (on Windows the same switch on `Nextcloud Talk.exe`). Talk keeps running in the tray, and
  quitting it during a call waits for a confirmation, so stop the running instance first, or the new
  one hands over to it and exits;
- the signaling traffic: add `--remote-debugging-port=9333 --remote-allow-origins=http://127.0.0.1:9333`,
  attach to the Talk page from `http://127.0.0.1:9333/json/list` over the DevTools protocol, enable
  `Network` and watch `Network.webSocketFrameSent`/`Received` for `"type":"rc"`. Every `rc` message
  of both sides is visible there, with the server-set `sender.userid`. The port listens on loopback
  only; do not leave it on;
- the presenter's main process writes `remote-control.log` (grants, revokes, refused requests,
  clipboard sizes) next to the app's logs: `%APPDATA%\Nextcloud Talk\logs` on Windows,
  `~/Library/Logs/Nextcloud Talk` on macOS.

**Rendering the consent window and the banner without a session.** Start the dev app with the main
process inspector, `CHANNEL=stable npx electron-forge start --inspect-electron`, and evaluate in
the main process over `ws://127.0.0.1:9229` (`process.mainModule.require('electron')`): open a
`BrowserWindow` with the preload `.webpack/renderer/talk_desktop__window_remote_control/preload.cjs`
on `https://app/talk_desktop__window_remote_control/index.html?mode=consent&name=…&login=…&what=window&title=…&clipboard=true&shortcut=false&windowMode=true`
(or `?mode=banner`, then send it `remoteControl:banner` with a state), and save
`webContents.capturePage()`. The windows take the language of the Nextcloud profile
(`appData.userMetadata.language`), the system language only without a login. When the dev app
cannot resolve `localhost` (seen during a network outage), re-handle the `https` protocol in the
main process to proxy `https://app/…` to `http://127.0.0.1:3000`.

## Testing log

**2026-11-20, `build-rc-1`.** Presenter: Windows, a.mamina, English interface. Controller: macOS,
Russian interface. Production HPB.

- At first neither client could connect to chats or send messages. That was a network outage,
  not the build: after it passed, the client log showed the signaling connected, rooms joined and
  chats loaded (one `ERR_CERT_AUTHORITY_INVALID` on the very first request, then normal).
- `hello`/`cap`, the request, the consent window, `accept`, heartbeats both ways and the session
  work over the production HPB; the traffic was read from the controller's signaling socket.
- The controller's clicks landed on the presenter's own Talk window (the call bar at the bottom
  of her screen) and were refused with `own-window`, as designed. The reason was shown for a
  fraction of a second only, because the release of the refused press reported `active` again.
  Fixed in `build-rc-2`: only an accepted press clears it, and the controller keeps it at least 3 s.
  **For a test the presenter has to minimise Talk or put another window in front.**
- The "Request control" button was not visible at first; once both clients had exchanged `hello`
  in the call it was. If it is missing, check the conditions in [User interface](#user-interface)
  and the `rc` traffic.
- Consent window: the buttons were cut off (fixed height, longer Russian text), the title of a
  shared window showed `&quot;` (`t()` escapes parameters, Vue escapes once more), and the layout
  was flat. Reworked: icon, title, who asks, what they will control, warnings as note cards; the
  window takes the height of its content (`remoteControl:consentResize`), parameters are passed with
  `{ escape: false }`. The text follows the interface language, as the rest of the app.
- Banner: the name was truncated. It now takes the width of its content
  (`remoteControl:bannerResize`) and stays where it is when it grows.
- Indicator border: 4 px → 1 px; the top strip was much thicker on Windows (caption minimum
  height of frameless windows), fixed in `build-rc-4`.

**2026-11-20, `build-rc-4`.** The "Request control" button was missing again. Cause: a race when
the two clients get to know each other. A client only accepts `rc` messages from participants it
already sees in the call (the HPB delivers from any session), and the two sides learn about each
other at slightly different times. The controller's first `hello` was dropped by the presenter and
never repeated; the presenter's own `hello` was not answered, because the controller had already
"sent" its one. The presenter therefore never learned about the controller and sent it no `cap`.
Fixed in `build-rc-5`: every first `hello` is answered with `re: true` (answers are not answered),
a `cap` arriving before its sender's `hello` is kept, and the control layer waits for the module to
attach instead of giving up when the screen share was shown first. `hello` and `cap` are logged to
the console (`[remote-control] hello from …`). On request, `build-rc-6` moves the button into the
call's bottom bar.

**2026-11-20, `build-rc-6`.** The button appears in the bottom bar and the session starts; control of
an application window (window mode) works on a Windows presenter. Found:
- The banner grew downwards without end. It measured its root element, which follows the window
  size, so every resize asked for the next one; on Windows `setContentSize` of a frameless window
  also added a frame it does not have. Fixed in `build-rc-7`: the banner measures its content, and
  the main process changes only the width with `setBounds`, keeping the height it was created with
  (the consent window also resizes with `setBounds` now).
- The banner showed "Name (login)"; on request it shows only the display name, like the rest of
  Talk. The consent window keeps the login against display-name spoofing.
- The button belongs next to the screen share button, not after the reactions: the mount point now
  follows `TopBarMediaControls`, whose last button is the screen share.
- The button showed no tooltip. It now has its own, shown on hover and focus, and `aria-describedby`.
- With `build-rc-7` the consent window spread wide on Windows. The resize now read the size back
  from the window (`getBounds`), and on Windows with a display scale other than 100 % a frameless
  window reports a pixel or so more than set: every round made it wider, the text reflowed and
  asked for the next round. Fixed in `build-rc-8`: the requested size is kept per window
  (`windowSizes`) and never read back.
- On a Mac, the message asking to allow access disappears at once when starting a screen share.
  Under investigation. Every test build has a new ad-hoc signature, so macOS loses the Screen
  Recording grant just like the Accessibility one; `app:getDesktopCapturerSources` (stock
  behaviour) then opens System Settings and closes the source dialog.

Not tested yet: input into the presenter's whole desktop, the keyboard and layouts,
the clipboard, macOS and Linux presenters, latency over the VPN, the open questions
below and the rest of the [test plan](#test-plan).

## Open questions for the prototype

1. Are context menus, drop-down lists and dialogs of a shared window visible to the viewers on
   Windows 10, Windows 11 and macOS? This decides the window-mode hints.
2. Does the captured window frame match `DWMWA_EXTENDED_FRAME_BOUNDS` at the corners (normal,
   maximised, snapped; Windows 10 and 11)?
3. Does the full-desktop capture on Windows with monitors of mixed scale cover exactly the
   physical virtual-desktop rectangle?
4. Actual frame rate and end-to-end latency of the share on the LAN and over the VPN.
5. Does `clipboard.has()` see the password-manager formats on Windows and macOS, or is koffi needed?
6. Does mstsc in full screen pass injected keys and Win shortcuts into the remote session?
7. macOS: does `CGEventPost` reach secure text fields (password fields with secure event input
   on); does injected Caps Lock toggle reliably; is natural scrolling applied twice?
8. Does HPB `2e544f8` behave like master in everything above (64 KiB, backend-only check)?

## Stages and estimate

| Stage | Content | Estimate |
|---|---|---|
| −1. Indicator | Finish change 6 from the stash and ship it on its own: the banner and the display mapping depend on it | 1–2 d |
| 0. Prototype | Windows, `entire-desktop` and `screen:`, mouse and keyboard, signaling, banner and shortcut; measure latency and frame rate on the LAN and over the VPN; answer open question 1 | 4–5 d |
| 1. Robustness | Watchdogs (both ways, renderer → main), `releaseAll`, `rel`, local priority, limits, checks, late events, revoke triggers, log | 3–4 d |
| 2. Window (Windows) | Rectangle, hit test, focus rule, window states, "Bring to front", mstsc | 3–4 d |
| 3. Clipboard | Both directions, parts, attribution rule, password-manager formats | 2–3 d |
| 4. UI | Request and offer, consent window, layer with panzoom paused, `before-input-event` capture, modifier mapping, hints, l10n | 3–4 d |
| 5. macOS | koffi in the universal build, CGEvent, Accessibility with ad-hoc signing, windows through CGWindowList, clipboard formats | 3–4 d |
| 6. Pilot | 3–5 people on the new build, then rollout with the next build | 1 week |

19–26 working days plus the pilot. Stage 5 can wait, since there is one Mac in the fleet.

## Test plan

Getting to know each other (the race of `build-rc-4`):

- The presenter joins first, the controller later; the other way round; both rejoin; the
  presenter starts sharing before and after the controller joins; the signaling reconnects.
  Every time the button appears in the controller's bottom bar within a few seconds of the share
  being shown big, and the console of both sides has `[remote-control] hello from …` and, on the
  controller, `[remote-control] cap from …`.
- A client of an older build (no module, or `build-rc-1…4`) in the same call: no button against
  it, no errors.

Screen:

- 1, 2 and 3 monitors with different scaling (100/125/150 %), the primary monitor not on the
  left. Clicks in the corners and the centre hit the pixel. A click on the outermost pixel (the
  Start corner) works while the indicator border is shown.
- `entire-desktop` with monitors of different resolutions: a click into a hole is dropped.
- The controller's screen-share zoom (panzoom), bars in the video (4:3 on 16:9), a reduced
  simulcast stream.
- A 144 Hz monitor on the controller side does not get the session revoked for flooding.

Window:

- normal, maximised, snapped, half off-screen, on a second monitor with another scale factor;
  Windows 10 and 11; clicks in the corners;
- the window is resized during control; minimised → pause → "Restore"; another window on top →
  "covered" → "Bring to front";
- Explorer, Word and Chrome with several windows: no click and no key reaches a window that is
  not shared. Test a UWP app (Calculator), and whether context menus and drop-down lists are visible;
- full-screen mstsc: mouse, keys, Ctrl+Alt+End, clipboard through rdpclip.

Keyboard:

- Different layouts on the two sides (Russian/English); Ctrl+C/V, Shift+arrows, F-keys, numpad.
- Mac → Windows and Windows → Mac: Cmd/Ctrl in shortcuts, the toggle.
- On the controller, Alt+←, the mouse back button, Ctrl+R, F5, Ctrl+W and Ctrl+= reach the
  presenter. The controller's Talk does not navigate back, reload or zoom, and M and Space do not
  touch the controller's microphone.
- With a Talk window in the foreground on the presenter, injected keys are dropped: the
  microphone stays on, nothing reaches the chat.

Clipboard:

- Cyrillic, emoji, CRLF; 200 KB of text goes through, 300 KB is refused with a message.
- After Ctrl+V the new text is pasted, not the previous one.
- Not sent: a copy from KeePass or Bitwarden; a local copy by the presenter during the session;
  whatever was in the clipboard before the session.

Disconnects and security:

- A network drop on the controller while Shift is held and a drag is in progress: nothing stays
  stuck on the presenter, and after reconnecting no old input is replayed.
- The presenter grabbing the mouse; the shortcut; the end of the share; screen lock; sleep; a
  reload of the presenter's Talk window.
- A forged `rc` from the browser console of a third participant, and from a session in
  **another room** (HPB delivers those), is rejected.
- An elevated window: input does not go through, Talk does not crash.
- macOS: after installing a new build the instructions for granting the permission again work;
  double click in Finder; drag; the local mouse takes over immediately.
- Control over the VPN.

## Maintenance

The feature lives in the fork: the module in `src/remote-control/` and the connector in
`.overrides/spreed`. It goes in as separate `feat(remote-control): …` commits, like the rest of
the fork, so it can be carried over on a rebase. Once implemented, it gets its own row in the
change table of [CUSTOM-BUILD.md](CUSTOM-BUILD.md) and a "what it has to keep" section like
change 1. The protocol is versioned (`v`): clients with a different `v` do not offer each other
control. It is worth proposing upstream after the pilot, as a separate RFC issue in spreed,
opened for discussion before any pull request.
