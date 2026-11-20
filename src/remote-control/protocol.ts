/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * Remote control during screen sharing: the messages exchanged over the call's signaling.
 * Shared by the main process and the renderer. See REMOTE-CONTROL.md, "Protocol".
 */

import { KEYMAP } from './keymap.ts'

export const RC_TYPE = 'rc'
export const RC_VERSION = 1

export type RcOs = 'win' | 'mac' | 'linux'
export type RcSourceKind = 'desktop' | 'screen' | 'window'
export type RcStateName = 'active' | 'paused' | 'blocked'
export type RcStateReason = 'local-input' | 'window-hidden' | 'window-occluded' | 'focus-elsewhere' | 'hb-lost' | 'own-window' | 'outside' | 'resizing'
export type RcDeclineReason = 'user' | 'timeout' | 'busy' | 'disabled' | 'unavailable'
export type RcRevokeReason = 'user' | 'share-ended' | 'left-call' | 'hb-lost' | 'flood' | 'lock-screen' | 'suspend' | 'renderer-gone' | 'window-closed' | 'error' | 'disabled'

type Base<Op extends string> = { type: typeof RC_TYPE, v: typeof RC_VERSION, op: Op, seq: number, t: number }

export type RcHello = Base<'hello'> & { roles: ('host' | 'ctl')[], os: RcOs }
export type RcCap = Base<'cap'> & { src: RcSourceKind | null, ok: boolean, why?: string }
export type RcRequest = Base<'request'>
export type RcAccept = Base<'accept'> & { sid: string, os: RcOs, src: RcSourceKind, clip: boolean }
export type RcDecline = Base<'decline'> & { why: RcDeclineReason }
export type RcFrame = Base<'frame'> & { sid: string, w: number, h: number }
export type RcPtr = Base<'ptr'> & { sid: string, x: number, y: number }
export type RcBtn = Base<'btn'> & { sid: string, b: number, d: boolean, x: number, y: number, n: number }
export type RcWheel = Base<'wheel'> & { sid: string, dx: number, dy: number, x: number, y: number }
export type RcKey = Base<'key'> & { sid: string, code: string, d: boolean }
export type RcRel = Base<'rel'> & { sid: string }
export type RcClip = Base<'clip'> & { sid: string, cid: number, i: number, n: number, data: string }
export type RcHb = Base<'hb'> & { sid: string }
export type RcState = Base<'state'> & { sid: string, s: RcStateName, why?: RcStateReason }
export type RcRevoke = Base<'revoke'> & { sid: string, why: RcRevokeReason }

export type RcMessage = RcHello | RcCap | RcRequest | RcAccept | RcDecline | RcFrame | RcPtr | RcBtn | RcWheel | RcKey | RcRel | RcClip | RcHb | RcState | RcRevoke
export type RcOp = RcMessage['op']

/** Messages carrying input or session traffic from the controller to the presenter */
export type RcInputMessage = RcFrame | RcPtr | RcBtn | RcWheel | RcKey | RcRel | RcClip | RcHb

/** A message without the envelope fields the sender fills in */
export type RcPayload<M extends RcMessage = RcMessage> = M extends RcMessage ? Omit<M, 'type' | 'v' | 'seq' | 't'> : never

export const LIMITS = Object.freeze({
	HEARTBEAT_INTERVAL: 1000,
	HEARTBEAT_PAUSE: 3000,
	HEARTBEAT_REVOKE: 15_000,
	RENDERER_PING_INTERVAL: 1000,
	RENDERER_PING_PAUSE: 3000,
	CONSENT_ENABLE_DELAY: 1000,
	CONSENT_TIMEOUT: 30_000,
	LOCAL_INPUT_PAUSE: 1500,
	LOCAL_CURSOR_POLL: 100,
	LOCAL_CURSOR_THRESHOLD: 4,
	CONTROLLER_MOVE_INTERVAL: 1000 / 60,
	MAX_PTR_PER_SECOND: 70,
	MAX_OTHER_PER_SECOND: 50,
	REQUEST_INTERVAL: 10_000,
	MAX_DECLINES: 3,
	LATE_EVENT: 1000,
	CLIP_MAX_BYTES: 256 * 1024,
	CLIP_PART_BYTES: 16 * 1024,
	CLIP_MAX_PARTS: 16,
	CLIP_MIN_INTERVAL: 1000,
	CLIP_INCOMPLETE: 2000,
	CLIP_ATTRIBUTION: 2000,
	WINDOW_RECT_CACHE: 50,
	ASPECT_TOLERANCE: 0.02,
	WHEEL_MAX: 1200,
})

/**
 * Keys a controller can never press, even though they are physical keys: the presenter's
 * revoke shortcut is Ctrl+Alt+Shift+Esc, and on Windows RegisterHotKey fires on injected
 * input too. Escape is only refused while Ctrl, Alt and Shift are all held.
 */
export const REVOKE_SHORTCUT = 'Control+Alt+Shift+Escape'

const OPS: ReadonlySet<string> = new Set(['hello', 'cap', 'request', 'accept', 'decline', 'frame', 'ptr', 'btn', 'wheel', 'key', 'rel', 'clip', 'hb', 'state', 'revoke'])
const SID_RE = /^[A-Za-z0-9_-]{22}$/
const STATE_REASONS: ReadonlySet<string> = new Set(['local-input', 'window-hidden', 'window-occluded', 'focus-elsewhere', 'hb-lost', 'own-window', 'outside', 'resizing'])

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max
const isUnit = (value: unknown): value is number => isFiniteNumber(value) && value >= 0 && value <= 1
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)

/**
 * Whether a key code may be sent to the presenter
 *
 * @param code - KeyboardEvent.code
 */
export function isAllowedKey(code: unknown): code is string {
	return typeof code === 'string' && Object.hasOwn(KEYMAP, code)
}

/**
 * Validate an incoming message against the schema. Anything that does not match exactly is
 * dropped: the sender may be any session on the signaling server.
 *
 * @param raw - The message data as received from the signaling
 * @return The message, or null when it is not a valid rc message
 */
export function parseRcMessage(raw: unknown): RcMessage | null {
	if (!isObject(raw) || raw.type !== RC_TYPE || raw.v !== RC_VERSION || !OPS.has(raw.op as string)) {
		return null
	}
	if (!isInt(raw.seq, 0, Number.MAX_SAFE_INTEGER) || !isFiniteNumber(raw.t)) {
		return null
	}
	const needsSid = !['hello', 'cap', 'request', 'decline'].includes(raw.op as string)
	if (needsSid && (typeof raw.sid !== 'string' || !SID_RE.test(raw.sid))) {
		return null
	}

	switch (raw.op) {
		case 'hello':
			return Array.isArray(raw.roles) && raw.roles.length <= 2 && raw.roles.every((role) => oneOf(role, ['host', 'ctl'])) && oneOf(raw.os, ['win', 'mac', 'linux'])
				? raw as RcHello
				: null
		case 'cap':
			return (raw.src === null || oneOf(raw.src, ['desktop', 'screen', 'window'])) && typeof raw.ok === 'boolean' && (raw.why === undefined || (typeof raw.why === 'string' && raw.why.length <= 64))
				? raw as RcCap
				: null
		case 'request':
			return raw as RcRequest
		case 'accept':
			return oneOf(raw.os, ['win', 'mac', 'linux']) && oneOf(raw.src, ['desktop', 'screen', 'window']) && typeof raw.clip === 'boolean'
				? raw as RcAccept
				: null
		case 'decline':
			return oneOf(raw.why, ['user', 'timeout', 'busy', 'disabled', 'unavailable']) ? raw as RcDecline : null
		case 'frame':
			return isInt(raw.w, 1, 32768) && isInt(raw.h, 1, 32768) ? raw as RcFrame : null
		case 'ptr':
			return isUnit(raw.x) && isUnit(raw.y) ? raw as RcPtr : null
		case 'btn':
			return isInt(raw.b, 0, 4) && typeof raw.d === 'boolean' && isUnit(raw.x) && isUnit(raw.y) && isInt(raw.n, 0, 3) ? raw as RcBtn : null
		case 'wheel':
			return isFiniteNumber(raw.dx) && isFiniteNumber(raw.dy) && Math.abs(raw.dx) <= LIMITS.WHEEL_MAX && Math.abs(raw.dy) <= LIMITS.WHEEL_MAX && isUnit(raw.x) && isUnit(raw.y)
				? raw as RcWheel
				: null
		case 'key':
			return isAllowedKey(raw.code) && typeof raw.d === 'boolean' ? raw as RcKey : null
		case 'rel':
		case 'hb':
			return raw as RcRel | RcHb
		case 'clip':
			return isInt(raw.cid, 0, Number.MAX_SAFE_INTEGER) && isInt(raw.n, 1, LIMITS.CLIP_MAX_PARTS) && isInt(raw.i, 0, (raw.n as number) - 1)
				&& typeof raw.data === 'string' && raw.data.length <= LIMITS.CLIP_PART_BYTES
				? raw as RcClip
				: null
		case 'state':
			return oneOf(raw.s, ['active', 'paused', 'blocked']) && (raw.why === undefined || STATE_REASONS.has(raw.why as string)) ? raw as RcState : null
		case 'revoke':
			return typeof raw.why === 'string' && raw.why.length <= 32 ? raw as RcRevoke : null
	}
	return null
}

/**
 * Split text into clipboard parts of at most CLIP_PART_BYTES of UTF-8 each,
 * never splitting a surrogate pair.
 *
 * @param text - The text to split
 * @return The parts, or null when the text is over the limit
 */
export function splitClipboardText(text: string): string[] | null {
	const encoder = new TextEncoder()
	if (encoder.encode(text).length > LIMITS.CLIP_MAX_BYTES) {
		return null
	}
	const parts: string[] = []
	let current = ''
	let currentBytes = 0
	for (const char of text) {
		const bytes = encoder.encode(char).length
		if (currentBytes + bytes > LIMITS.CLIP_PART_BYTES) {
			parts.push(current)
			current = ''
			currentBytes = 0
		}
		current += char
		currentBytes += bytes
	}
	parts.push(current)
	return parts.length <= LIMITS.CLIP_MAX_PARTS ? parts : null
}

/**
 * The kind of a screensharing source by its sourceId
 *
 * @param sourceId - A sourceId from the screensharing dialog
 */
export function getSourceKind(sourceId: string): RcSourceKind | null {
	if (sourceId === 'entire-desktop:0:0') {
		return 'desktop'
	}
	if (sourceId.startsWith('screen:')) {
		return 'screen'
	}
	if (sourceId.startsWith('window:')) {
		return 'window'
	}
	return null
}
