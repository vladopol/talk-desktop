/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * The controller's side in the renderer: requests control, sends input from the layer over
 * the presenter's screen, and receives the presenter's clipboard.
 */

import type { RcDeclineReason, RcMessage, RcOs, RcRevokeReason, RcSourceKind, RcStateReason } from '../protocol.ts'
import type { Channel, Peer } from './channel.ts'

import { reactive } from 'vue'
import { LIMITS, splitClipboardText } from '../protocol.ts'

export type ControlStatus = 'idle' | 'requesting' | 'active' | 'paused' | 'blocked' | 'lost'

/** What the layer over a presenter's screen shows */
export type ControlState = {
	status: ControlStatus
	/** Why the last request was declined or the session ended, or why input is paused or blocked */
	why: RcDeclineReason | RcRevokeReason | RcStateReason | 'timeout' | null
	src: RcSourceKind | null
	os: RcOs | null
	clipboard: boolean
	mapModifiers: boolean
	/** Size of the last clipboard text received from the presenter, for a short note */
	clipboardIn: number | null
}

type Session = {
	presenter: string
	sid: string
	lastFromPresenter: number
	incoming: { cid: number, parts: string[], received: number, timer: number } | null
	clipboardId: number
}

/** How long the reason a click was refused stays visible, ms */
const BLOCKED_HINT_MIN = 3000

const MODIFIER_RE = /^(Control|Alt|Shift|Meta)(Left|Right)$/

/**
 * The controller's side of one call signaling connection
 */
export class Client {
	/** Per presenter session id */
	readonly states = reactive(new Map<string, ControlState>())
	private session: Session | null = null
	private requestTimer: number | null = null
	private heartbeatTimer: number | null = null
	private moveTimer: number | null = null
	private pendingMove: { x: number, y: number } | null = null
	private pendingWheel = { dx: 0, dy: 0, x: 0, y: 0 }
	/** The presenter whose screen the layer currently shows, with the layer attached */
	private attached: string | null = null
	/** Whether the layer has the keyboard focus: only then keys go to the presenter */
	private focused = false
	private wasConnected = true
	private blockedAt = 0
	private blockedTimer: number | null = null
	private heldModifiers = new Set<string>()
	/** Whether the local user is being controlled: then they cannot control anyone */
	private beingControlled = false
	private readonly unsubscribe: (() => void)[] = []

	constructor(
		private readonly channel: Channel,
		private readonly peers: Map<string, Peer>,
		private readonly ownOs: RcOs,
	) {
		this.unsubscribe.push(this.channel.listen((from, _fromUserId, message) => this.handle(from, message)))
		this.unsubscribe.push(window.TALK_DESKTOP.remoteControl.on('capturedKey', (code: string, down: boolean) => this.sendKey(code, down)))
		this.unsubscribe.push(window.TALK_DESKTOP.remoteControl.on('capturedPaste', (text: string) => this.sendClipboard(text)))
		this.unsubscribe.push(window.TALK_DESKTOP.remoteControl.on('hostSession', (hostSession: unknown) => {
			this.beingControlled = !!hostSession
			if (this.beingControlled) {
				this.stop('user')
			}
		}))
	}

	destroy() {
		this.stop('left-call')
		for (const unsubscribe of this.unsubscribe) {
			unsubscribe()
		}
	}

	/**
	 * The state for a presenter, created on first use
	 *
	 * @param presenter - Signaling session id of the presenter
	 */
	state(presenter: string): ControlState {
		let state = this.states.get(presenter)
		if (!state) {
			state = { status: 'idle', why: null, src: null, os: null, clipboard: false, mapModifiers: true, clipboardIn: null }
			this.states.set(presenter, state)
			state = this.states.get(presenter)!
		}
		return state
	}

	/**
	 * Whether control can be requested from a presenter now
	 *
	 * @param presenter - Signaling session id of the presenter
	 */
	canRequest(presenter: string) {
		const peer = this.peers.get(presenter)
		return !!peer?.roles.includes('host') && !!peer.cap?.ok && !this.session && !this.beingControlled && this.channel.connected
	}

	/**
	 * Ask a presenter for control
	 *
	 * @param presenter - Signaling session id of the presenter
	 */
	request(presenter: string) {
		if (!this.canRequest(presenter) || this.requestTimer !== null) {
			return
		}
		const state = this.state(presenter)
		if (!this.channel.send(presenter, { op: 'request' })) {
			return
		}
		state.status = 'requesting'
		state.why = null
		this.requestTimer = window.setTimeout(() => {
			this.requestTimer = null
			if (state.status === 'requesting') {
				state.status = 'idle'
				state.why = 'timeout'
			}
		}, LIMITS.CONSENT_TIMEOUT + 5000)
	}

	/**
	 * End the session from the controller's side
	 *
	 * @param why - Why
	 */
	stop(why: RcRevokeReason) {
		const session = this.session
		if (session) {
			this.channel.send(session.presenter, { op: 'rel', sid: session.sid })
			this.channel.send(session.presenter, { op: 'revoke', sid: session.sid, why })
		}
		this.end(why)
	}

	/**
	 * The layer over a presenter's screen is shown (or hidden, with null). Input is only sent
	 * from the big screen: on the compact overlay or another big video nothing is sent.
	 *
	 * @param presenter - Signaling session id of the presenter, or null
	 */
	attach(presenter: string | null) {
		if (this.attached === presenter) {
			return
		}
		if (this.attached && this.session?.presenter === this.attached) {
			this.release()
		}
		this.attached = presenter
		this.focused = false
		this.updateCapture()
	}

	/**
	 * The layer got or lost the keyboard focus. Keys are captured only while it has it, so
	 * the chat next to the call stays usable.
	 *
	 * @param focused - Whether the layer has the focus
	 */
	setFocused(focused: boolean) {
		if (this.focused === focused) {
			return
		}
		this.focused = focused
		if (!focused) {
			this.release()
		}
		this.updateCapture()
	}

	/**
	 * Toggle the Cmd ↔ Ctrl mapping
	 *
	 * @param presenter - Signaling session id of the presenter
	 * @param map - Whether to map
	 */
	setMapModifiers(presenter: string, map: boolean) {
		this.state(presenter).mapModifiers = map
		this.updateCapture()
	}

	/**
	 * Size of the shown frame
	 *
	 * @param width - videoWidth
	 * @param height - videoHeight
	 */
	frame(width: number, height: number) {
		const session = this.activeSession()
		if (session && width > 0 && height > 0) {
			this.channel.send(session.presenter, { op: 'frame', sid: session.sid, w: Math.round(width), h: Math.round(height) })
		}
	}

	/**
	 * Mouse moves are coalesced to at most 60 per second by a timer, not by animation frames:
	 * on a 144 Hz monitor that would be 144 per second, over the presenter's limit
	 *
	 * @param x - 0…1 across the frame
	 * @param y - 0…1 down the frame
	 */
	move(x: number, y: number) {
		if (!this.activeSession()) {
			return
		}
		this.pendingMove = { x, y }
		this.pendingWheel.x = x
		this.pendingWheel.y = y
		this.moveTimer ??= window.setInterval(() => this.flushMoves(), LIMITS.CONTROLLER_MOVE_INTERVAL)
	}

	/**
	 * @param button - 0 left, 1 middle, 2 right, 3 back, 4 forward
	 * @param down - Pressed or released
	 * @param x - 0…1 across the frame
	 * @param y - 0…1 down the frame
	 * @param clickCount - event.detail
	 */
	button(button: number, down: boolean, x: number, y: number, clickCount: number) {
		const session = this.activeSession()
		if (!session || button < 0 || button > 4) {
			return
		}
		this.flushMoves()
		this.channel.send(session.presenter, { op: 'btn', sid: session.sid, b: button, d: down, x, y, n: Math.min(Math.max(clickCount, 0), 3) })
	}

	/**
	 * Wheel deltas, already in 1/120 of a notch, accumulated and sent with the moves
	 *
	 * @param dx - Horizontal
	 * @param dy - Vertical
	 * @param x - 0…1 across the frame
	 * @param y - 0…1 down the frame
	 * @param ctrlKey - event.ctrlKey: a touchpad pinch arrives as a wheel with it set
	 */
	wheel(dx: number, dy: number, x: number, y: number, ctrlKey: boolean) {
		if (!this.activeSession()) {
			return
		}
		const ctrlHeld = [...this.heldModifiers].some((code) => code.startsWith('Control') || code.startsWith('Meta'))
		if (ctrlKey && !ctrlHeld) {
			return
		}
		this.pendingWheel.dx += dx
		this.pendingWheel.dy += dy
		this.move(x, y)
	}

	/**
	 * Release everything held on the presenter's side: the layer lost focus, the window was
	 * minimised, the pointer capture was lost
	 */
	release() {
		const session = this.activeSession(true)
		this.heldModifiers.clear()
		if (session) {
			this.channel.send(session.presenter, { op: 'rel', sid: session.sid })
		}
	}

	/**
	 * Send the local clipboard to the presenter, for pasting through a context menu
	 */
	async sendLocalClipboard() {
		const session = this.activeSession()
		if (!session || !this.state(session.presenter).clipboard) {
			return
		}
		try {
			this.sendClipboard(await navigator.clipboard.readText())
		} catch (error) {
			console.error('[remote-control] Failed to read the clipboard:', error)
		}
	}

	/**
	 * The session while input may be sent: active, attached to the layer, connected
	 *
	 * @param evenIfPaused - Also while paused or blocked, for releases
	 */
	private activeSession(evenIfPaused = false) {
		const session = this.session
		if (!session || this.attached !== session.presenter || !this.channel.connected) {
			return null
		}
		const status = this.state(session.presenter).status
		if (status === 'active' || status === 'blocked' || (evenIfPaused && status === 'paused')) {
			return session
		}
		return null
	}

	private flushMoves() {
		const session = this.activeSession()
		if (!session) {
			this.pendingMove = null
			this.pendingWheel.dx = this.pendingWheel.dy = 0
			return
		}
		if (this.pendingMove) {
			this.channel.send(session.presenter, { op: 'ptr', sid: session.sid, ...this.pendingMove })
			this.pendingMove = null
		}
		const wheel = this.pendingWheel
		if (wheel.dx || wheel.dy) {
			const clamp = (value: number) => Math.max(-LIMITS.WHEEL_MAX, Math.min(LIMITS.WHEEL_MAX, Math.round(value)))
			this.channel.send(session.presenter, { op: 'wheel', sid: session.sid, dx: clamp(wheel.dx), dy: clamp(wheel.dy), x: wheel.x, y: wheel.y })
			wheel.dx = wheel.dy = 0
		}
	}

	private sendKey(code: string, down: boolean) {
		const session = this.activeSession(!down)
		if (MODIFIER_RE.test(code)) {
			if (down) {
				this.heldModifiers.add(code)
			} else {
				this.heldModifiers.delete(code)
			}
		}
		if (session) {
			this.flushMoves()
			this.channel.send(session.presenter, { op: 'key', sid: session.sid, code, d: down })
		}
	}

	private sendClipboard(text: string) {
		const session = this.activeSession()
		if (!session || !this.state(session.presenter).clipboard || !text) {
			return
		}
		const parts = splitClipboardText(text)
		if (!parts) {
			return
		}
		const cid = ++session.clipboardId
		parts.forEach((data, i) => this.channel.send(session.presenter, { op: 'clip', sid: session.sid, cid, i, n: parts.length, data }))
	}

	private updateCapture() {
		const session = this.session
		if (!session || this.attached !== session.presenter || !this.focused) {
			window.TALK_DESKTOP.remoteControl.capture(null)
			return
		}
		const state = this.state(session.presenter)
		window.TALK_DESKTOP.remoteControl.capture({ presenterOs: state.os ?? 'win', mapModifiers: state.mapModifiers, clipboard: state.clipboard })
	}

	private start(presenter: string, message: Extract<RcMessage, { op: 'accept' }>) {
		const state = this.state(presenter)
		this.clearRequestTimer()
		this.session = { presenter, sid: message.sid, lastFromPresenter: performance.now(), incoming: null, clipboardId: 0 }
		Object.assign(state, { status: 'active', why: null, src: message.src, os: message.os, clipboard: message.clip, clipboardIn: null })
		this.wasConnected = this.channel.connected
		this.heartbeatTimer = window.setInterval(() => this.heartbeat(), LIMITS.HEARTBEAT_INTERVAL)
		this.updateCapture()
	}

	private end(why: ControlState['why']) {
		const session = this.session
		this.session = null
		this.clearRequestTimer()
		if (this.heartbeatTimer !== null) {
			window.clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
		if (this.moveTimer !== null) {
			window.clearInterval(this.moveTimer)
			this.moveTimer = null
		}
		this.pendingMove = null
		this.heldModifiers.clear()
		if (session) {
			if (session.incoming) {
				window.clearTimeout(session.incoming.timer)
			}
			Object.assign(this.state(session.presenter), { status: 'idle', why })
		}
		window.TALK_DESKTOP.remoteControl.capture(null)
	}

	private clearRequestTimer() {
		if (this.requestTimer !== null) {
			window.clearTimeout(this.requestTimer)
			this.requestTimer = null
		}
	}

	private heartbeat() {
		const session = this.session
		if (!session) {
			return
		}
		const connected = this.channel.connected
		if (connected && !this.wasConnected) {
			// Whatever was pressed before the connection dropped is released
			this.channel.send(session.presenter, { op: 'rel', sid: session.sid })
		}
		this.wasConnected = connected
		this.channel.send(session.presenter, { op: 'hb', sid: session.sid })

		const state = this.state(session.presenter)
		const lost = performance.now() - session.lastFromPresenter > LIMITS.HEARTBEAT_PAUSE
		if (lost && state.status !== 'lost') {
			state.status = 'lost'
			state.why = 'hb-lost'
		} else if (!lost && state.status === 'lost') {
			state.status = 'active'
			state.why = null
		}
		if (performance.now() - session.lastFromPresenter > LIMITS.HEARTBEAT_REVOKE) {
			this.end('hb-lost')
		}
	}

	private handle(from: string, message: RcMessage) {
		const state = this.states.get(from)
		switch (message.op) {
			case 'accept':
				if (state?.status === 'requesting' && !this.session) {
					this.start(from, message)
				}
				return
			case 'decline':
				if (state?.status === 'requesting') {
					this.clearRequestTimer()
					state.status = 'idle'
					state.why = message.why
				}
				return
		}

		const session = this.session
		if (!session || session.presenter !== from || !('sid' in message) || message.sid !== session.sid) {
			return
		}
		session.lastFromPresenter = performance.now()
		const current = this.state(from)
		switch (message.op) {
			case 'hb':
				if (current.status === 'lost') {
					current.status = 'active'
					current.why = null
				}
				return
			case 'state':
				this.applyState(current, message.s, message.why ?? null)
				return
			case 'revoke':
				this.end(message.why)
				return
			case 'clip':
				this.receiveClipboardPart(session, message)
		}
	}

	private receiveClipboardPart(session: Session, part: Extract<RcMessage, { op: 'clip' }>) {
		if (!this.state(session.presenter).clipboard) {
			return
		}
		if (!session.incoming || session.incoming.cid !== part.cid) {
			if (session.incoming) {
				window.clearTimeout(session.incoming.timer)
			}
			session.incoming = {
				cid: part.cid,
				parts: Array.from({ length: part.n }, () => ''),
				received: 0,
				timer: window.setTimeout(() => {
					session.incoming = null
				}, LIMITS.CLIP_INCOMPLETE),
			}
		}
		const incoming = session.incoming
		if (part.n !== incoming.parts.length || incoming.parts[part.i]) {
			return
		}
		incoming.parts[part.i] = part.data
		if (++incoming.received < part.n) {
			return
		}
		window.clearTimeout(incoming.timer)
		session.incoming = null
		const text = incoming.parts.join('')
		window.TALK_DESKTOP.remoteControl.writeClipboard(text)
		const state = this.state(session.presenter)
		state.clipboardIn = text.length
		window.setTimeout(() => {
			if (state.clipboardIn === text.length) {
				state.clipboardIn = null
			}
		}, 4000)
	}

	/**
	 * A refused click is reported as blocked and the next accepted one as active again,
	 * often a fraction of a second later. Keep the reason visible long enough to be read.
	 *
	 * @param state - The state of the presenter's screen
	 * @param status - The new status
	 * @param why - Why
	 */
	private applyState(state: ControlState, status: ControlState['status'], why: ControlState['why']) {
		if (this.blockedTimer !== null) {
			window.clearTimeout(this.blockedTimer)
			this.blockedTimer = null
		}
		const shownFor = performance.now() - this.blockedAt
		if (status === 'active' && state.status === 'blocked' && shownFor < BLOCKED_HINT_MIN) {
			this.blockedTimer = window.setTimeout(() => {
				this.blockedTimer = null
				if (state.status === 'blocked') {
					state.status = 'active'
					state.why = null
				}
			}, BLOCKED_HINT_MIN - shownFor)
			return
		}
		if (status === 'blocked') {
			this.blockedAt = performance.now()
		}
		state.status = status
		state.why = why
	}

	/**
	 * Whether the two sides run different OSes, which makes the Cmd ↔ Ctrl toggle relevant
	 *
	 * @param presenter
	 */
	osDiffers(presenter: string) {
		const os = this.state(presenter).os
		return !!os && (os === 'mac') !== (this.ownOs === 'mac')
	}
}
