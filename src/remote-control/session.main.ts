/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * Remote control: the presenter's session (kept here, in the main process, which re-checks
 * everything the renderer forwards) and the controller's key capture and clipboard.
 * See REMOTE-CONTROL.md.
 */

import type { WebContents } from 'electron'
import type { ControlledSource, Injector, MouseButton, OsPoint, OsRect } from './injector.types.ts'
import type { RcClip, RcDeclineReason, RcInputMessage, RcOs, RcPayload, RcRevokeReason, RcSourceKind, RcStateName, RcStateReason } from './protocol.ts'

import { app, clipboard, desktopCapturer, globalShortcut, ipcMain, powerMonitor } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getAppConfig } from '../app/AppConfig.ts'
import { isMac, isWindows } from '../app/system.utils.ts'
import { BUILD_CONFIG } from '../shared/build.config.ts'
import { KEYMAP } from './keymap.ts'
import { rcLog } from './log.main.ts'
import { getSourceKind, LIMITS, parseRcMessage, splitClipboardText } from './protocol.ts'
import { closeConsentWindow, hideBanner, isConsentWindowOpen, showBanner, showConsentWindow } from './remoteControl.window.ts'

const REVOKE_ACCELERATOR = 'Control+Alt+Shift+Escape'

const OS: RcOs = isWindows ? 'win' : isMac ? 'mac' : 'linux'

/** A participant who asked for control, as the renderer resolved them from the call */
type Requester = {
	/** Signaling session id, set by the server */
	from: string
	/** Login, set by the server */
	userId: string
	/** Display name */
	name: string
	/** OS the controller announced in hello */
	os: RcOs
}

type Session = Requester & {
	sid: string
	source: ControlledSource
	clipboard: boolean
	state: RcStateName
	stateWhy: RcStateReason | null
	/** Last reason a single event was blocked, to report a change only once */
	blockedWhy: RcStateReason | null
	lastSeq: number
	minClockOffset: number
	lastHeartbeat: number
	frame: { w: number, h: number } | null
	rectCache: { rect: OsRect, at: number } | null
	/** Where the injector last put the cursor */
	injectedCursor: OsPoint | null
	/** Where the cursor was at the previous local input check */
	polledCursor: OsPoint | null
	lastLocalInput: number
	/** Whether the presenter's foreground window is elevated (Windows), for the banner */
	foregroundElevated: boolean
	/** A leaveElevated call in progress */
	leaving: boolean
	rate: { second: number, ptr: number, other: number }
	/** Clipboard parts being received */
	incoming: { cid: number, parts: string[], received: number, timer: NodeJS.Timeout } | null
	/** When the controller last pressed a copy shortcut or clicked */
	copyIntentAt: number
	/** Hash of the text last written from the controller, not to send it back */
	echoHash: string | null
	lastClipboardSequence: number | null
	lastClipboardHash: string | null
	lastClipboardSent: number
	clipboardId: number
	/** Modifiers currently held by the controller, by code */
	heldModifiers: Set<string>
	timers: NodeJS.Timeout[]
}

let injector: Injector | null = null
/** The Talk window that shares, and sends and receives signaling messages */
let owner: WebContents | null = null
/** The sourceId currently being shared by the local user, or null */
let sharedSourceId: string | null = null
let session: Session | null = null
let consentPending: Requester | null = null
let rendererPingAt = 0
const requestHistory = new Map<string, { at: number, declines: number }>()

/**
 * The injector for this OS, or null where the presenter is not supported
 */
async function getInjector(): Promise<Injector | null> {
	if (injector) {
		return injector
	}
	if (isWindows) {
		const { WindowsInjector } = await import('./injector.win.ts')
		injector = new WindowsInjector()
	} else if (isMac) {
		const { MacInjector } = await import('./injector.mac.ts')
		injector = new MacInjector()
	} else if (process.platform === 'linux') {
		const { LinuxInjector } = await import('./injector.linux.ts')
		injector = new LinuxInjector()
	}
	return injector
}

/**
 * Whether the feature is enabled at all
 */
function isEnabled() {
	return BUILD_CONFIG.remoteControl !== false && getAppConfig('allowRemoteControl') !== false
}

/**
 * Send a message to a participant through the owner renderer's signaling
 *
 * @param to - Signaling session id
 * @param payload - The message without the envelope
 */
function send(to: string, payload: RcPayload) {
	if (owner && !owner.isDestroyed()) {
		owner.send('remoteControl:send', to, payload)
	}
}

/**
 * Whether the current share can be controlled, and why not
 */
async function getCapability(): Promise<{ src: RcSourceKind | null, ok: boolean, why?: string }> {
	const src = sharedSourceId ? getSourceKind(sharedSourceId) : null
	if (!isEnabled()) {
		return { src, ok: false, why: 'disabled' }
	}
	if (!src) {
		return { src, ok: false, why: 'not-sharing' }
	}
	const native = await getInjector()
	if (!native) {
		return { src, ok: false, why: 'unsupported' }
	}
	const availability = native.availability()
	if (!availability.ok) {
		// XTest does not reach native Wayland windows
		return { src, ok: false, why: OS === 'linux' && availability.why === 'unsupported' ? 'wayland' : availability.why }
	}
	if (src === 'desktop' && isMac) {
		return { src, ok: false, why: 'unsupported' }
	}
	return { src, ok: true }
}

/**
 * Resolve the shared source for control
 *
 * @param sourceId - The sourceId being shared
 */
async function resolveSource(sourceId: string): Promise<ControlledSource | null> {
	const kind = getSourceKind(sourceId)
	if (!kind) {
		return null
	}
	if (kind === 'desktop') {
		return { kind, sourceId, windowId: null, displayId: null }
	}
	if (kind === 'window') {
		const windowId = Number(sourceId.split(':')[1])
		return Number.isSafeInteger(windowId) && windowId > 0 ? { kind, sourceId, windowId, displayId: null } : null
	}
	// A screen maps to a display only through display_id. Without it, control is not
	// possible: outlining every display is fine for a border, never for input.
	const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
	const displayId = sources.find((source) => source.id === sourceId)?.display_id
	return displayId ? { kind, sourceId, windowId: null, displayId } : null
}

/**
 * Describe the source for the consent window
 *
 * @param source - The source
 */
async function describeSource(source: ControlledSource) {
	if (source.kind !== 'window') {
		return ''
	}
	try {
		const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
		return sources.find((candidate) => candidate.id === source.sourceId)?.name ?? ''
	} catch {
		return ''
	}
}

/**
 * Handle a request for control from a participant. The renderer has already checked that
 * the sender is a Nextcloud user in this call whose login matches the server-set one.
 *
 * @param requester - Who asks
 */
async function handleRequest(requester: Requester) {
	const decline = (why: RcDeclineReason) => {
		send(requester.from, { op: 'decline', why })
		rcLog('decline', { from: requester.from, userId: requester.userId, why })
	}

	if (session || consentPending || isConsentWindowOpen()) {
		return decline('busy')
	}
	// Taken before the first await: a second request arriving meanwhile is busy, it must not
	// replace the consent window of the first one
	consentPending = requester
	try {
		await askConsent(requester, decline)
	} finally {
		consentPending = null
	}
}

/**
 * The checks and the consent window of a request that holds the consent slot
 *
 * @param requester - Who asks
 * @param decline - Declines the request
 */
async function askConsent(requester: Requester, decline: (why: RcDeclineReason) => void) {
	const capability = await getCapability()
	if (!capability.ok) {
		return decline(capability.why === 'disabled' ? 'disabled' : 'unavailable')
	}
	const history = requestHistory.get(requester.from) ?? { at: 0, declines: 0 }
	const now = Date.now()
	if (now - history.at < LIMITS.REQUEST_INTERVAL || history.declines >= LIMITS.MAX_DECLINES) {
		return decline('user')
	}
	history.at = now
	requestHistory.set(requester.from, history)

	const sourceId = sharedSourceId!
	const source = await resolveSource(sourceId)
	if (!source) {
		return decline('unavailable')
	}

	// Registered for the consent window, to tell whether it is free. Kept for the session,
	// released when no session follows.
	const registeredHere = !globalShortcut.isRegistered(REVOKE_ACCELERATOR) && registerRevokeShortcut()
	const shortcut = registeredHere || globalShortcut.isRegistered(REVOKE_ACCELERATOR)
	const clipboardAllowed = getAppConfig('remoteControlClipboard') !== false
	rcLog('consent-shown', { from: requester.from, userId: requester.userId, source: source.kind })
	const result = await showConsentWindow({
		name: requester.name,
		login: requester.userId,
		what: source.kind,
		title: await describeSource(source),
		clipboard: clipboardAllowed,
		shortcut,
		windowMode: source.kind === 'window',
	})

	// Everything may have changed while the window was open
	if (!result.allow || sharedSourceId !== sourceId || session) {
		if (registeredHere && !session) {
			globalShortcut.unregister(REVOKE_ACCELERATOR)
		}
		history.declines++
		return decline(result.why === 'timeout' ? 'timeout' : 'user')
	}
	history.declines = 0
	startSession(requester, source, result.clipboard)
}

/**
 * Register the revoke shortcut
 *
 * @return Whether it could be registered
 */
function registerRevokeShortcut() {
	try {
		return globalShortcut.register(REVOKE_ACCELERATOR, () => revoke('user'))
	} catch {
		return false
	}
}

/**
 * Start a session after consent
 *
 * @param requester - The controller
 * @param source - The shared source
 * @param clipboardEnabled - Whether the clipboard is shared
 */
function startSession(requester: Requester, source: ControlledSource, clipboardEnabled: boolean) {
	const now = performance.now()
	session = {
		...requester,
		sid: randomBytes(16).toString('base64url'),
		source,
		clipboard: clipboardEnabled,
		state: 'active',
		stateWhy: null,
		blockedWhy: null,
		lastSeq: -1,
		minClockOffset: Number.POSITIVE_INFINITY,
		lastHeartbeat: now,
		frame: null,
		rectCache: null,
		injectedCursor: null,
		polledCursor: null,
		lastLocalInput: 0,
		foregroundElevated: false,
		leaving: false,
		rate: { second: 0, ptr: 0, other: 0 },
		incoming: null,
		copyIntentAt: 0,
		echoHash: null,
		lastClipboardSequence: null,
		lastClipboardHash: null,
		lastClipboardSent: 0,
		clipboardId: 0,
		heldModifiers: new Set(),
		timers: [],
	}
	rendererPingAt = now
	registerRevokeShortcut()

	// The consent click made Talk the foreground app, so a window may be raised now
	if (source.kind === 'window') {
		injector!.bringToFront(source)
	}

	const current = session
	current.timers.push(setInterval(() => watchdog(current), 250))
	current.timers.push(setInterval(() => watchLocalCursor(current), LIMITS.LOCAL_CURSOR_POLL))
	current.timers.push(setInterval(() => send(current.from, { op: 'hb', sid: current.sid }), LIMITS.HEARTBEAT_INTERVAL))
	if (current.clipboard) {
		current.timers.push(setInterval(() => watchClipboard(current), isWindows ? 250 : 500))
		snapshotClipboard(current)
	}

	send(current.from, { op: 'accept', sid: current.sid, os: OS, src: source.kind, clip: current.clipboard })
	updateBanner()
	notifyOwner()
	rcLog('grant', { from: current.from, userId: current.userId, source: source.kind, clipboard: current.clipboard })
}

/**
 * End the session, whatever the reason. Releases everything first.
 *
 * @param why - Why
 * @param notify - Whether to tell the controller
 */
function revoke(why: RcRevokeReason, notify = true) {
	if (consentPending && (why === 'share-ended' || why === 'left-call' || why === 'renderer-gone' || why === 'lock-screen' || why === 'suspend')) {
		closeConsentWindow()
	}
	if (!session) {
		return
	}
	const ended = session
	session = null
	try {
		injector?.releaseAll()
	} catch (error) {
		console.error('[remote-control] releaseAll failed:', error)
	}
	for (const timer of ended.timers) {
		clearInterval(timer)
	}
	if (ended.incoming) {
		clearTimeout(ended.incoming.timer)
	}
	globalShortcut.unregister(REVOKE_ACCELERATOR)
	hideBanner()
	if (notify) {
		send(ended.from, { op: 'revoke', sid: ended.sid, why })
	}
	notifyOwner()
	rcLog('revoke', { from: ended.from, userId: ended.userId, why })
}

/**
 * Tell the owner renderer about the session, for the "Take back" button in the call
 */
function notifyOwner() {
	if (owner && !owner.isDestroyed()) {
		owner.send('remoteControl:hostSession', session ? { from: session.from, name: session.name } : null)
	}
}

/**
 * Show the banner for the current session state
 *
 * @param clipboardNote - A short note about a clipboard transfer
 */
function updateBanner(clipboardNote: string | null = null) {
	if (!session) {
		return
	}
	if (clipboardNote) {
		// The note is shown for a few seconds, then the banner shows the state again
		const current = session
		setTimeout(() => session === current && updateBanner(), 4000)
	}
	showBanner({
		name: session.name,
		windowMode: session.source.kind === 'window',
		state: session.state,
		why: session.stateWhy,
		elevated: session.foregroundElevated,
		clipboard: clipboardNote,
	}, (action) => {
		if (action === 'take-back') {
			revoke('user')
		} else if (action === 'bring-to-front' && session) {
			injector!.bringToFront(session.source)
		}
	})
}

/**
 * Switch the session state, telling the controller and releasing everything when leaving active
 *
 * @param current - The session
 * @param state - The new state
 * @param why - Why
 */
function setState(current: Session, state: RcStateName, why: RcStateReason | null) {
	if (current.state === state && current.stateWhy === why) {
		return
	}
	if (current.state === 'active' && state !== 'active') {
		injector!.releaseAll()
		current.heldModifiers.clear()
	}
	current.blockedWhy = null
	current.state = state
	current.stateWhy = why
	send(current.from, { op: 'state', sid: current.sid, s: state, ...(why ? { why } : {}) })
	updateBanner()
}

/**
 * Report that a single event was blocked, once per reason
 *
 * @param current - The session
 * @param why - Why the event was not executed, or null when it was
 */
function reportBlocked(current: Session, why: RcStateReason | null) {
	if (current.blockedWhy === why || current.state !== 'active') {
		return
	}
	current.blockedWhy = why
	send(current.from, why ? { op: 'state', sid: current.sid, s: 'blocked', why } : { op: 'state', sid: current.sid, s: 'active' })
}

/**
 * Heartbeats both ways and the renderer ping; window states
 *
 * @param current - The session
 */
function watchdog(current: Session) {
	if (session !== current) {
		return
	}
	const now = performance.now()
	if (now - current.lastHeartbeat > LIMITS.HEARTBEAT_REVOKE) {
		return revoke('hb-lost')
	}
	const heartbeatLost = now - current.lastHeartbeat > LIMITS.HEARTBEAT_PAUSE
	// The renderer hung, possibly with a key held
	const rendererLost = now - rendererPingAt > LIMITS.RENDERER_PING_PAUSE

	let windowHidden = false
	if (current.source.kind === 'window') {
		const state = injector!.windowState(current.source)
		if (state === 'gone') {
			return revoke('window-closed')
		}
		windowHidden = state === 'hidden'
	}

	// The controller keeps the hint and the "Switch window" button for as long as the elevated
	// window is in the foreground, wherever the pointer is: it may be over the taskbar
	const elevated = injector!.foregroundElevated()
	if (elevated !== current.foregroundElevated) {
		current.foregroundElevated = elevated
		rcLog('foreground-elevated', { from: current.from, elevated })
		updateBanner()
		if (!elevated && (current.blockedWhy === 'elevated' || current.blockedWhy === 'elevated-failed')) {
			reportBlocked(current, null)
		}
	}
	// Re-reported on every tick: a pause or an accepted click clears the reason in between
	if (elevated && !current.blockedWhy) {
		reportBlocked(current, 'elevated')
	}

	const localInput = now - current.lastLocalInput < LIMITS.LOCAL_INPUT_PAUSE
	if (heartbeatLost || rendererLost) {
		setState(current, 'paused', 'hb-lost')
	} else if (localInput) {
		setState(current, 'paused', 'local-input')
	} else if (windowHidden) {
		setState(current, 'paused', 'window-hidden')
	} else {
		setState(current, 'active', null)
	}
}

/**
 * Local input wins: when the cursor moved since the last check and is not where the injector
 * put it, the presenter moved the mouse, and remote input pauses until LOCAL_INPUT_PAUSE after
 * the last such movement.
 *
 * A cursor that did not move at all is not local input: it is injected input that did not
 * land. Over an elevated window Windows drops injected moves, the cursor stays behind the
 * injected point, and the session kept pausing itself as if the presenter were moving the mouse.
 *
 * @param current - The session
 */
function watchLocalCursor(current: Session) {
	if (session !== current) {
		return
	}
	const cursor = injector!.cursor()
	if (!cursor) {
		return
	}
	const previous = current.polledCursor
	current.polledCursor = cursor
	if (!current.injectedCursor || !previous) {
		return
	}
	const moved = Math.hypot(cursor.x - previous.x, cursor.y - previous.y) > LIMITS.LOCAL_CURSOR_THRESHOLD
	const distance = Math.hypot(cursor.x - current.injectedCursor.x, cursor.y - current.injectedCursor.y)
	if (moved && distance > LIMITS.LOCAL_CURSOR_THRESHOLD) {
		current.lastLocalInput = performance.now()
		current.injectedCursor = cursor
		if (current.state === 'active') {
			setState(current, 'paused', 'local-input')
		}
	}
}

/**
 * The source rectangle, cached for moves and read fresh for clicks
 *
 * @param current - The session
 * @param fresh - Whether to bypass the cache
 */
function getSourceRect(current: Session, fresh: boolean): OsRect | null {
	const now = performance.now()
	if (!fresh && current.rectCache && now - current.rectCache.at < LIMITS.WINDOW_RECT_CACHE) {
		return current.rectCache.rect
	}
	const rect = injector!.sourceRect(current.source)
	current.rectCache = rect ? { rect, at: now } : null
	return rect
}

/**
 * Map a normalised frame point to OS coordinates
 *
 * @param current - The session
 * @param x - 0…1 across the frame
 * @param y - 0…1 down the frame
 * @param forClick - Whether this is a click, which needs a fresh rectangle and a matching frame
 */
function mapPoint(current: Session, x: number, y: number, forClick: boolean): OsPoint | RcStateReason {
	const rect = getSourceRect(current, forClick || current.source.kind === 'window')
	if (!rect || rect.width < 1 || rect.height < 1) {
		return 'outside'
	}
	// A window being resized: the frame lags behind the window, so clicks would miss
	if (forClick && current.frame) {
		const ratio = (current.frame.w / current.frame.h) / (rect.width / rect.height)
		if (Math.abs(ratio - 1) > LIMITS.ASPECT_TOLERANCE) {
			return 'resizing'
		}
	}
	const point = {
		x: Math.min(rect.x + x * rect.width, rect.x + rect.width - 1),
		y: Math.min(rect.y + y * rect.height, rect.y + rect.height - 1),
	}
	// Physical pixels everywhere but on macOS
	if (!isMac) {
		point.x = Math.round(point.x)
		point.y = Math.round(point.y)
	}
	return injector!.isOnScreen(point) ? point : 'outside'
}

/**
 * Count the event against the rate limits
 *
 * @param current - The session
 * @param op - The message op
 * @return Whether the limit is exceeded
 */
function overRateLimit(current: Session, op: RcInputMessage['op']) {
	const second = Math.floor(performance.now() / 1000)
	if (current.rate.second !== second) {
		current.rate = { second, ptr: 0, other: 0 }
	}
	if (op === 'ptr') {
		return ++current.rate.ptr > LIMITS.MAX_PTR_PER_SECOND
	}
	if (op === 'hb') {
		return false
	}
	return ++current.rate.other > LIMITS.MAX_OTHER_PER_SECOND
}

/**
 * Whether the key press is a copy shortcut on the presenter's OS
 *
 * @param current - The session
 * @param code - The key pressed
 */
function isCopyShortcut(current: Session, code: string) {
	const held = current.heldModifiers
	const command = isMac ? (held.has('MetaLeft') || held.has('MetaRight')) : (held.has('ControlLeft') || held.has('ControlRight'))
	const shift = held.has('ShiftLeft') || held.has('ShiftRight')
	return (command && (code === 'KeyC' || code === 'KeyX' || code === 'Insert')) || (shift && code === 'Delete')
}

/**
 * The revoke shortcut must never be pressed by the controller: on Windows a hotkey
 * also fires on injected input
 *
 * @param current - The session
 * @param code - The key pressed
 */
function isRevokeShortcut(current: Session, code: string) {
	const held = current.heldModifiers
	return code === 'Escape'
		&& (held.has('ControlLeft') || held.has('ControlRight'))
		&& (held.has('AltLeft') || held.has('AltRight'))
		&& (held.has('ShiftLeft') || held.has('ShiftRight'))
}

/**
 * Execute one message from the controller after all the checks
 *
 * @param from - Signaling session id of the sender, set by the server
 * @param raw - The message
 */
function handleInput(from: string, raw: unknown) {
	const current = session
	const message = parseRcMessage(raw)
	if (!current || !message || from !== current.from) {
		return
	}
	if (message.op === 'request' || !('sid' in message) || message.sid !== current.sid) {
		return
	}
	if (message.op === 'revoke') {
		return revoke('user', false)
	}
	if (!['frame', 'ptr', 'btn', 'wheel', 'key', 'rel', 'esc', 'clip', 'hb'].includes(message.op)) {
		return
	}
	const input = message as RcInputMessage

	// Strictly increasing per sender: stale moves are dropped
	if (input.seq <= current.lastSeq) {
		return
	}
	current.lastSeq = input.seq

	if (overRateLimit(current, input.op)) {
		return revoke('flood')
	}

	// Late events: the best clock offset seen so far is the reference
	const offset = performance.now() - input.t
	current.minClockOffset = Math.min(current.minClockOffset, offset)
	if (input.op === 'hb') {
		current.lastHeartbeat = performance.now()
		return
	}
	// A release is never late: a key or a button must not stay down on the presenter
	const isRelease = (input.op === 'key' || input.op === 'btn') && !input.d
	if (offset - current.minClockOffset > LIMITS.LATE_EVENT && input.op !== 'rel' && input.op !== 'clip' && !isRelease) {
		return
	}

	switch (input.op) {
		case 'frame':
			current.frame = { w: input.w, h: input.h }
			return
		case 'rel':
			current.heldModifiers.clear()
			injector!.releaseAll()
			return
		case 'clip':
			return receiveClipboardPart(current, input)
	}

	if (current.state !== 'active') {
		return
	}

	switch (input.op) {
		case 'ptr': {
			const point = mapPoint(current, input.x, input.y, false)
			if (typeof point === 'string') {
				return
			}
			// The move is sent anyway: it is harmless if dropped, and the cursor must be able to
			// leave the elevated window. The controller learns why clicks there do nothing.
			if (injector!.hitTest(point, current.source) === 'elevated') {
				reportBlocked(current, 'elevated')
			} else if (!current.foregroundElevated && current.blockedWhy === 'elevated') {
				reportBlocked(current, null)
			}
			injector!.move(point)
			current.injectedCursor = point
			return
		}
		case 'esc':
			leaveElevated(current)
			return
		case 'btn': {
			const point = mapPoint(current, input.x, input.y, input.d)
			// A release always goes through: a button must never stay down
			if (typeof point === 'string') {
				if (!input.d && current.injectedCursor) {
					injector!.button(input.b as MouseButton, false, current.injectedCursor, input.n)
				}
				return reportBlocked(current, point)
			}
			if (input.d) {
				const hit = injector!.hitTest(point, current.source)
				if (hit !== 'ok') {
					return reportBlocked(current, hit)
				}
				current.copyIntentAt = performance.now()
				// Only a press that went through clears the hint; the release of a refused
				// press is not one
				reportBlocked(current, null)
			}
			injector!.button(input.b as MouseButton, input.d, point, input.n)
			current.injectedCursor = point
			return
		}
		case 'wheel': {
			const point = mapPoint(current, input.x, input.y, false)
			if (typeof point === 'string') {
				return
			}
			const hit = injector!.hitTest(point, current.source)
			if (hit !== 'ok') {
				return reportBlocked(current, hit)
			}
			injector!.wheel(input.dx, input.dy, point)
			current.injectedCursor = point
			return
		}
		case 'key': {
			const key = KEYMAP[input.code]!
			if (!input.d) {
				current.heldModifiers.delete(input.code)
				injector!.key(key, false)
				return
			}
			if (isRevokeShortcut(current, input.code)) {
				return
			}
			const target = injector!.keyTarget(current.source)
			if (target !== 'ok') {
				return reportBlocked(current, target)
			}
			reportBlocked(current, null)
			if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(input.code)) {
				current.heldModifiers.add(input.code)
			} else if (isCopyShortcut(current, input.code)) {
				current.copyIntentAt = performance.now()
			}
			injector!.key(key, true)
		}
	}
}

/**
 * The controller asks to get an elevated foreground window out of the way: injected input,
 * Alt+Tab included, does not reach it, so only the presenter's Talk can switch away from it
 *
 * @param current - The session
 */
async function leaveElevated(current: Session) {
	if (current.leaving) {
		return
	}
	current.leaving = true
	try {
		const result = await injector!.leaveElevated(current.source)
		rcLog('leave-elevated', { from: current.from, result })
		if (session !== current) {
			return
		}
		if (result === 'failed') {
			reportBlocked(current, 'elevated-failed')
		} else {
			current.foregroundElevated = injector!.foregroundElevated()
			updateBanner()
			reportBlocked(current, current.foregroundElevated ? 'elevated' : null)
		}
	} catch (error) {
		console.error('[remote-control] leaveElevated failed:', error)
		if (session === current) {
			reportBlocked(current, 'elevated-failed')
		}
	} finally {
		current.leaving = false
	}
}

/**
 * Assemble clipboard parts from the controller and write the text on the last one.
 * Ordering is strict, so the paste shortcut that follows pastes the new text.
 *
 * @param current - The session
 * @param part - The part
 */
function receiveClipboardPart(current: Session, part: RcClip) {
	if (!current.clipboard) {
		return
	}
	if (!current.incoming || current.incoming.cid !== part.cid) {
		if (current.incoming) {
			clearTimeout(current.incoming.timer)
		}
		current.incoming = {
			cid: part.cid,
			parts: Array.from({ length: part.n }, () => ''),
			received: 0,
			timer: setTimeout(() => {
				if (current.incoming?.cid === part.cid) {
					current.incoming = null
					rcLog('clipboard-incomplete', { from: current.from })
				}
			}, LIMITS.CLIP_INCOMPLETE),
		}
	}
	const incoming = current.incoming
	if (part.n !== incoming.parts.length || incoming.parts[part.i]) {
		return
	}
	incoming.parts[part.i] = part.data
	incoming.received++
	if (incoming.received < part.n) {
		return
	}
	clearTimeout(incoming.timer)
	current.incoming = null

	let text = incoming.parts.join('').replaceAll('\0', '')
	if (new TextEncoder().encode(text).length > LIMITS.CLIP_MAX_BYTES) {
		return
	}
	text = text.replace(/\r\n|\r|\n/g, isWindows ? '\r\n' : '\n')
	current.echoHash = hash(text)
	current.lastClipboardHash = current.echoHash
	clipboard.writeText(text).then(() => {
		current.lastClipboardSequence = injector!.clipboardSequence()
	})
	rcLog('clipboard-in', { from: current.from, bytes: text.length })
	updateBanner(`in:${text.length}`)
}

/**
 * Remember the clipboard as it was when the session started: it is never sent
 *
 * @param current - The session
 */
async function snapshotClipboard(current: Session) {
	current.lastClipboardSequence = injector!.clipboardSequence()
	if (current.lastClipboardSequence === null) {
		current.lastClipboardHash = hash(await clipboard.readText())
	}
}

/**
 * Send a clipboard change to the controller, if the controller made it
 *
 * @param current - The session
 */
async function watchClipboard(current: Session) {
	if (session !== current) {
		return
	}
	const sequence = injector!.clipboardSequence()
	if (sequence !== null) {
		if (sequence === current.lastClipboardSequence) {
			return
		}
		current.lastClipboardSequence = sequence
	}
	const text = await clipboard.readText()
	const textHash = hash(text)
	if (textHash === current.lastClipboardHash) {
		return
	}
	current.lastClipboardHash = textHash

	const now = performance.now()
	// Only a change the controller made: within a short time after their copy shortcut or
	// click, with no local input since
	const attributed = now - current.copyIntentAt < LIMITS.CLIP_ATTRIBUTION && current.lastLocalInput < current.copyIntentAt
	if (!attributed || !text || textHash === current.echoHash || session !== current || current.state !== 'active') {
		return
	}
	if (now - current.lastClipboardSent < LIMITS.CLIP_MIN_INTERVAL) {
		return
	}
	// Passwords are never sent
	if (await injector!.clipboardIsSensitive()) {
		rcLog('clipboard-sensitive', { from: current.from })
		return
	}
	const parts = splitClipboardText(text)
	if (!parts) {
		rcLog('clipboard-too-large', { from: current.from, bytes: text.length })
		return
	}
	current.lastClipboardSent = now
	const cid = ++current.clipboardId
	parts.forEach((data, i) => send(current.from, { op: 'clip', sid: current.sid, cid, i, n: parts.length, data }))
	rcLog('clipboard-out', { from: current.from, bytes: text.length })
	updateBanner(`out:${text.length}`)
}

/**
 * @param text - Text
 */
function hash(text: string) {
	return createHash('sha256').update(text).digest('base64')
}

// ---------------------------------------------------------------------------------------
// Controller side: key capture and the clipboard
// ---------------------------------------------------------------------------------------

type Capture = {
	webContents: WebContents
	presenterOs: RcOs
	mapModifiers: boolean
	clipboard: boolean
	listener: (event: Electron.Event, input: Electron.Input) => void
}

let capture: Capture | null = null
const capturedModifiers = new Set<string>()

/**
 * Whether a Talk window currently captures keys for remote control.
 * Other before-input-event handlers (back/forward navigation) step aside while it does.
 *
 * @param webContents - The window's web contents
 */
export function isCapturingInput(webContents: WebContents) {
	return capture?.webContents === webContents
}

/**
 * Map Cmd and Ctrl between macOS and the other systems
 *
 * @param code - KeyboardEvent.code
 */
function mapModifier(code: string) {
	if (!capture?.mapModifiers || (OS === 'mac') === (capture.presenterOs === 'mac')) {
		return code
	}
	if (OS === 'mac') {
		// Cmd on the controller's Mac is Ctrl on the presenter's PC
		return code.replace(/^Meta/, 'Control')
	}
	// Ctrl on the controller's PC is Cmd on the presenter's Mac, and the Windows key is Ctrl
	if (code.startsWith('Control')) {
		return code.replace(/^Control/, 'Meta')
	}
	return code.replace(/^Meta/, 'Control')
}

/**
 * Whether the mapped key press is a paste shortcut on the presenter's OS
 *
 * @param code - Mapped KeyboardEvent.code
 */
function isPasteShortcut(code: string) {
	const command = capture!.presenterOs === 'mac' ? 'Meta' : 'Control'
	const commandHeld = capturedModifiers.has(command + 'Left') || capturedModifiers.has(command + 'Right')
	const shiftHeld = capturedModifiers.has('ShiftLeft') || capturedModifiers.has('ShiftRight')
	return (commandHeld && code === 'KeyV') || (shiftHeld && code === 'Insert')
}

const watchedForDestroy = new WeakSet<Electron.WebContents>()

/**
 * Start or stop capturing keys in a Talk window for a remote control session
 *
 * @param webContents - The controller's Talk window
 * @param options - Session options, or null to stop
 */
function setCapture(webContents: WebContents, options: { presenterOs: RcOs, mapModifiers: boolean, clipboard: boolean } | null) {
	if (capture) {
		capture.webContents.removeListener('before-input-event', capture.listener)
		capture = null
		capturedModifiers.clear()
	}
	if (!options) {
		return
	}
	const listener = (event: Electron.Event, input: Electron.Input) => {
		if (input.type !== 'keyDown' && input.type !== 'keyUp') {
			return
		}
		// Ctrl+W, Ctrl+R, F5, F11, F12, Alt, Ctrl+Tab, the menu accelerators, back/forward
		// navigation and the call hotkeys of Talk: nothing reaches the page or the menu
		event.preventDefault()
		const down = input.type === 'keyDown'
		if (down && input.isAutoRepeat) {
			// The presenter's OS generates the auto-repeat itself
			return
		}
		const code = mapModifier(input.code)
		if (!Object.hasOwn(KEYMAP, code)) {
			return
		}
		if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) {
			if (down) {
				capturedModifiers.add(code)
			} else {
				capturedModifiers.delete(code)
			}
		}
		if (down && capture?.clipboard && isPasteShortcut(code)) {
			// The controller's clipboard leaves the machine only on a physical paste shortcut
			clipboard.readText().then((text) => {
				if (capture?.webContents === webContents && text) {
					webContents.send('remoteControl:capturedPaste', text)
				}
				webContents.send('remoteControl:capturedKey', code, down)
			})
			return
		}
		webContents.send('remoteControl:capturedKey', code, down)
	}
	webContents.on('before-input-event', listener)
	// Once per window: setCapture runs on every focus change of the layer
	if (!watchedForDestroy.has(webContents)) {
		watchedForDestroy.add(webContents)
		webContents.once('destroyed', () => {
			if (capture?.webContents === webContents) {
				capture = null
			}
		})
	}
	capture = { webContents, ...options, listener }
}

// ---------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------

/**
 * Remember the Talk window that runs the call
 *
 * @param sender - The sender of an IPC message
 */
function adoptOwner(sender: WebContents) {
	if (owner === sender) {
		return
	}
	owner = sender
	const adopted = sender
	sender.once('destroyed', () => {
		if (owner === adopted) {
			revoke('renderer-gone', false)
			owner = null
			sharedSourceId = null
		}
	})
	sender.on('render-process-gone', () => owner === adopted && revoke('renderer-gone', false))
	sender.on('did-start-navigation', (details) => {
		if (owner === adopted && details.isMainFrame && !details.isSameDocument) {
			revoke('renderer-gone', false)
		}
	})
}

/**
 * Register the IPC handlers and the system event triggers. Called once from main.js.
 */
export function setupRemoteControl() {
	ipcMain.handle('remoteControl:capability', async () => ({ os: OS, ...(await getCapability()) }))

	ipcMain.on('remoteControl:share', (event, sourceId: string | null) => {
		adoptOwner(event.sender)
		const previous = sharedSourceId
		sharedSourceId = typeof sourceId === 'string' && getSourceKind(sourceId) ? sourceId : null
		if (session && session.source.sourceId !== sharedSourceId) {
			revoke('share-ended')
		} else if (!sharedSourceId && previous) {
			revoke('share-ended')
		}
	})

	ipcMain.on('remoteControl:request', (event, requester: Requester) => {
		adoptOwner(event.sender)
		if (typeof requester?.from !== 'string' || typeof requester.userId !== 'string' || !requester.userId) {
			return
		}
		handleRequest({
			from: requester.from,
			userId: requester.userId,
			name: String(requester.name ?? requester.userId).slice(0, 100),
			os: ['win', 'mac', 'linux'].includes(requester.os) ? requester.os : 'linux',
		})
	})

	// One ordered channel for everything the controller sends
	ipcMain.on('remoteControl:input', (event, from: string, message: unknown) => {
		if (event.sender === owner) {
			handleInput(from, message)
		}
	})

	ipcMain.on('remoteControl:ping', (event) => {
		if (event.sender === owner) {
			rendererPingAt = performance.now()
		}
	})

	ipcMain.on('remoteControl:revoke', (event, why: RcRevokeReason) => {
		if (event.sender === owner) {
			revoke(['user', 'left-call', 'share-ended'].includes(why) ? why : 'user')
		}
	})

	ipcMain.on('remoteControl:participantLeft', (event, sessionId: string) => {
		if (event.sender !== owner) {
			return
		}
		if (session?.from === sessionId) {
			revoke('left-call', false)
		}
		if (consentPending?.from === sessionId) {
			closeConsentWindow()
		}
	})

	ipcMain.on('remoteControl:requestPermission', async () => {
		(await getInjector())?.requestPermission()
	})

	// Controller side
	ipcMain.on('remoteControl:capture', (event, options: { presenterOs: RcOs, mapModifiers: boolean, clipboard: boolean } | null) => {
		setCapture(event.sender, options && {
			presenterOs: ['win', 'mac', 'linux'].includes(options.presenterOs) ? options.presenterOs : 'win',
			mapModifiers: options.mapModifiers !== false,
			clipboard: options.clipboard === true && getAppConfig('remoteControlClipboard') !== false,
		})
	})

	ipcMain.on('remoteControl:writeClipboard', (event, text: string) => {
		// Only while this window controls someone, and within the limit
		if (capture?.webContents !== event.sender || !capture.clipboard || typeof text !== 'string') {
			return
		}
		if (new TextEncoder().encode(text).length > LIMITS.CLIP_MAX_BYTES) {
			return
		}
		clipboard.writeText(text.replaceAll('\0', '').replace(/\r\n|\r|\n/g, isWindows ? '\r\n' : '\n'))
	})

	powerMonitor.on('lock-screen', () => revoke('lock-screen'))
	powerMonitor.on('suspend', () => revoke('suspend'))
	app.on('before-quit', () => {
		revoke('user')
		injector?.releaseAll()
	})
}
