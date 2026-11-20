/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RcMessage, RcOs, RcPayload, RcSourceKind } from '../protocol.ts'

import { parseRcMessage, RC_TYPE, RC_VERSION } from '../protocol.ts'

/** The parts of spreed's call signaling the module uses */
export type SpreedSignaling = {
	connected?: boolean
	currentCallToken?: string | null
	getSessionId(): string
	emit(event: 'message', data: Record<string, unknown>): void
	on(event: string, handler: (...args: never[]) => void): void
	off(event: string, handler: (...args: never[]) => void): void
}

/** A call participant model of spreed */
export type SpreedParticipant = {
	attributes: { peerId: string, actorType?: string, actorId?: string, userId?: string, name?: string | null }
}

export type SpreedCollection = {
	callParticipantModels: SpreedParticipant[]
	get(peerId: string): SpreedParticipant | undefined
	on(event: 'add' | 'remove', handler: (collection: unknown, model: SpreedParticipant) => void): void
	off(event: 'add' | 'remove', handler: (collection: unknown, model: SpreedParticipant) => void): void
}

export type SpreedLocalMediaModel = {
	attributes: { localScreen: MediaStream | null }
	on(event: 'change:localScreen', handler: (model: unknown, screen: MediaStream | null) => void): void
	off(event: 'change:localScreen', handler: (model: unknown, screen: MediaStream | null) => void): void
}

export type AttachOptions = {
	signaling: SpreedSignaling
	callParticipantCollection: SpreedCollection
	localMediaModel: SpreedLocalMediaModel
}

/** What is known about another participant's client */
export type Peer = {
	roles: ('host' | 'ctl')[]
	os: RcOs
	cap: { src: RcSourceKind | null, ok: boolean, why?: string } | null
}

type Listener = (from: string, fromUserId: string, message: RcMessage) => void

/**
 * The call's signaling as a channel of rc messages
 */
export class Channel {
	private seq = 0
	private listeners = new Set<Listener>()
	private readonly onMessage = (data: Record<string, unknown>) => {
		if (data?.type !== RC_TYPE || typeof data.from !== 'string') {
			return
		}
		const message = parseRcMessage(data)
		if (!message) {
			return
		}
		const fromUserId = typeof data.fromUserId === 'string' ? data.fromUserId : ''
		for (const listener of this.listeners) {
			listener(data.from, fromUserId, message)
		}
	}

	constructor(readonly signaling: SpreedSignaling) {
		signaling.on('message', this.onMessage as never)
	}

	destroy() {
		this.signaling.off('message', this.onMessage as never)
		this.listeners.clear()
	}

	/** Our own signaling session id */
	get sessionId() {
		return this.signaling.getSessionId()
	}

	/**
	 * Whether messages can be sent now. While the socket is down spreed queues messages and
	 * replays them all after reconnecting; for input that means old clicks arriving seconds
	 * late, so nothing is sent instead.
	 */
	get connected() {
		return this.signaling.connected === true
	}

	/**
	 * @param listener - Called for every valid rc message
	 * @return Unsubscribe
	 */
	listen(listener: Listener) {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/**
	 * Send a message to one session
	 *
	 * @param to - Signaling session id
	 * @param payload - The message without the envelope
	 * @return Whether it was sent
	 */
	send(to: string, payload: RcPayload) {
		if (!this.connected) {
			return false
		}
		this.signaling.emit('message', { ...payload, type: RC_TYPE, v: RC_VERSION, seq: ++this.seq, t: performance.now(), to })
		return true
	}
}
