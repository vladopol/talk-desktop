/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * The presenter's side in the renderer: receives rc messages, checks who sent them, and
 * forwards them to the main process, which keeps the session and checks everything again.
 */

import type { RcMessage, RcOs, RcPayload, RcSourceKind } from '../protocol.ts'
import type { AttachOptions, Channel, Peer, SpreedParticipant } from './channel.ts'

import { LIMITS } from '../protocol.ts'

type Capability = { os: RcOs, src: RcSourceKind | null, ok: boolean, why?: string }

/** The sourceId picked in the screensharing dialog of Talk Desktop */
let pickedSourceId: string | null = null

/**
 * Remember the source the user picked to share. Called by the screensharing dialog.
 *
 * @param sourceId - The picked sourceId, or an empty string when cancelled
 */
export function setPickedSourceId(sourceId: string) {
	pickedSourceId = sourceId || null
}

/**
 * The presenter's side of one call signaling connection
 */
export class Host {
	private capability: Capability | null = null
	private sharing = false
	private pingTimer: number | null = null
	private readonly unsubscribe: (() => void)[] = []

	constructor(
		private readonly channel: Channel,
		private readonly options: AttachOptions,
		private readonly peers: Map<string, Peer>,
	) {
		const { callParticipantCollection, localMediaModel } = options

		const onScreen = (_: unknown, screen: MediaStream | null) => this.setSharing(!!screen)
		localMediaModel.on('change:localScreen', onScreen)
		this.unsubscribe.push(() => localMediaModel.off('change:localScreen', onScreen))

		const onRemove = (_: unknown, model: SpreedParticipant) => window.TALK_DESKTOP.remoteControl.participantLeft(model.attributes.peerId)
		callParticipantCollection.on('remove', onRemove)
		this.unsubscribe.push(() => callParticipantCollection.off('remove', onRemove))

		this.unsubscribe.push(window.TALK_DESKTOP.remoteControl.on('send', (to: string, payload: RcPayload) => {
			this.channel.send(to, payload)
		}))

		this.unsubscribe.push(this.channel.listen((from, fromUserId, message) => this.handle(from, fromUserId, message)))

		if (localMediaModel.attributes.localScreen) {
			this.setSharing(true)
		}
	}

	destroy() {
		this.setSharing(false)
		for (const unsubscribe of this.unsubscribe) {
			unsubscribe()
		}
	}

	/** The capability to announce in hello and cap */
	get cap() {
		return this.capability
	}

	/**
	 * The local user started or stopped sharing
	 *
	 * @param sharing - Whether a screen or a window is shared
	 */
	private async setSharing(sharing: boolean) {
		this.sharing = sharing
		window.TALK_DESKTOP.remoteControl.share(sharing ? pickedSourceId : null)
		if (sharing && this.pingTimer === null) {
			// The main process pauses the session when the renderer stops pinging: a hung
			// renderer must not leave a key held down
			this.pingTimer = window.setInterval(() => window.TALK_DESKTOP.remoteControl.ping(), LIMITS.RENDERER_PING_INTERVAL)
		} else if (!sharing && this.pingTimer !== null) {
			window.clearInterval(this.pingTimer)
			this.pingTimer = null
		}
		await this.refreshCapability()
	}

	/**
	 * Ask main whether the share can be controlled and tell the controllers
	 */
	async refreshCapability() {
		this.capability = this.sharing ? await window.TALK_DESKTOP.remoteControl.capability() : null
		for (const [sessionId, peer] of this.peers) {
			if (peer.roles.includes('ctl')) {
				this.sendCap(sessionId)
			}
		}
	}

	/**
	 * @param to - Signaling session id
	 */
	sendCap(to: string) {
		const cap = this.capability
		this.channel.send(to, cap ? { op: 'cap', src: cap.src, ok: cap.ok, ...(cap.why ? { why: cap.why } : {}) } : { op: 'cap', src: null, ok: false })
	}

	/**
	 * The sender must be a Nextcloud user in this call right now, whose login is the
	 * server-set one. The signaling server delivers messages from any session of any user
	 * of the server, so this check comes before anything is shown.
	 *
	 * @param from - Server-set session id
	 * @param fromUserId - Server-set login
	 */
	private findParticipant(from: string, fromUserId: string) {
		if (!fromUserId) {
			return null
		}
		const model = this.options.callParticipantCollection.get(from)
		if (!model || model.attributes.actorType !== 'users' || model.attributes.actorId !== fromUserId) {
			return null
		}
		return model
	}

	private handle(from: string, fromUserId: string, message: RcMessage) {
		if (!this.sharing) {
			return
		}
		switch (message.op) {
			case 'request': {
				const model = this.findParticipant(from, fromUserId)
				const peer = this.peers.get(from)
				if (!model || !peer) {
					return
				}
				window.TALK_DESKTOP.remoteControl.request({
					from,
					userId: fromUserId,
					name: model.attributes.name || fromUserId,
					os: peer.os,
				})
				return
			}
			case 'frame':
			case 'ptr':
			case 'btn':
			case 'wheel':
			case 'key':
			case 'rel':
			case 'clip':
			case 'hb':
			case 'revoke':
				// Main checks the session, the sender and everything else
				if (this.findParticipant(from, fromUserId)) {
					window.TALK_DESKTOP.remoteControl.input(from, message)
				}
		}
	}
}
