/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 * OCA.Talk.Desktop.remoteControl: what the connector in Talk (spreed) calls.
 * See REMOTE-CONTROL.md, "Shape: a module with a thin connector".
 */

import type { RcOs } from '../protocol.ts'
import type { AttachOptions, Peer, SpreedParticipant } from './channel.ts'

import { createApp, reactive } from 'vue'
import { Channel } from './channel.ts'
import { Client } from './client.ts'
import { Host } from './host.ts'

export type MountScreenOptions = {
	/** The container of the screen share, the layer is mounted into it */
	container: HTMLElement
	video: HTMLVideoElement
	/** Signaling session id of the presenter */
	peerId: string
	/** Pause or resume Talk's own zoom and hide its bottom bar */
	setControlled: (controlled: boolean) => void
}

type Connection = {
	options: AttachOptions
	channel: Channel
	peers: Map<string, Peer>
	host: Host
	client: Client
	helloSent: Set<string>
	dispose: () => void
}

let connection: Connection | null = null
let ownOs: RcOs | null = null

/**
 * The roles this client announces: every desktop client can control and give control; whether
 * the current share can actually be controlled is announced separately in cap
 */
function getRoles(): ('host' | 'ctl')[] {
	// On Linux the presenter needs X11; on Wayland the capability says why not
	return ['host', 'ctl']
}

/**
 * Attach to the call's signaling. Called by spreed whenever its WebRTC is set up.
 *
 * @param options - spreed's signaling, call participants and local media
 */
async function attach(options: AttachOptions) {
	ownOs ??= (await window.TALK_DESKTOP.remoteControl.capability() as { os: RcOs }).os
	if (connection?.options.signaling === options.signaling) {
		return
	}
	connection?.dispose()

	const { signaling, callParticipantCollection } = options
	const channel = new Channel(signaling)
	const peers = reactive(new Map<string, Peer>())
	const host = new Host(channel, options, peers)
	const client = new Client(channel, peers, ownOs)
	const helloSent = new Set<string>()
	const call = { inCall: !!signaling.currentCallToken }

	const sendHello = (to: string) => {
		if (channel.send(to, { op: 'hello', roles: getRoles(), os: ownOs! })) {
			helloSent.add(to)
		}
	}
	const helloEveryone = () => {
		for (const model of callParticipantCollection.callParticipantModels) {
			sendHello(model.attributes.peerId)
		}
	}

	const onAdd = (_: unknown, model: SpreedParticipant) => {
		if (call.inCall) {
			sendHello(model.attributes.peerId)
		}
	}
	const onRemove = (_: unknown, model: SpreedParticipant) => {
		const peerId = model.attributes.peerId
		peers.delete(peerId)
		helloSent.delete(peerId)
		client.states.delete(peerId)
	}
	const onJoinCall = () => {
		call.inCall = true
		helloEveryone()
	}
	const onLeaveCall = () => {
		call.inCall = false
		window.TALK_DESKTOP.remoteControl.revoke('left-call')
		client.stop('left-call')
		peers.clear()
		helloSent.clear()
	}
	// After a reconnect the other side may have missed everything
	const onConnect = () => {
		helloSent.clear()
		if (call.inCall) {
			helloEveryone()
		}
	}

	const stopListening = channel.listen((from, _fromUserId, message) => {
		// Only participants of this call: the signaling server delivers from any session
		if (!call.inCall || !callParticipantCollection.get(from)) {
			return
		}
		if (message.op === 'hello') {
			const peer = peers.get(from)
			peers.set(from, { roles: message.roles, os: message.os, cap: peer?.cap ?? null })
			if (!helloSent.has(from)) {
				sendHello(from)
			}
			if (message.roles.includes('ctl')) {
				host.sendCap(from)
			}
		} else if (message.op === 'cap') {
			const peer = peers.get(from)
			if (peer) {
				peer.cap = { src: message.src, ok: message.ok, ...(message.why ? { why: message.why } : {}) }
			}
		}
	})

	callParticipantCollection.on('add', onAdd)
	callParticipantCollection.on('remove', onRemove)
	signaling.on('joinCall', onJoinCall)
	signaling.on('leaveCall', onLeaveCall)
	signaling.on('connect', onConnect)

	const current: Connection = {
		options,
		channel,
		peers,
		host,
		client,
		helloSent,
		dispose() {
			stopListening()
			callParticipantCollection.off('add', onAdd)
			callParticipantCollection.off('remove', onRemove)
			signaling.off('joinCall', onJoinCall)
			signaling.off('leaveCall', onLeaveCall)
			signaling.off('connect', onConnect)
			client.destroy()
			host.destroy()
			channel.destroy()
		},
	}
	connection = current
	if (call.inCall) {
		helloEveryone()
	}
}

/**
 * Mount the control layer over the big screen share of another participant
 *
 * @param options - The screen share
 * @return Unmount
 */
function mountScreen(options: MountScreenOptions): () => void {
	const element = options.container.appendChild(document.createElement('div'))
	element.className = 'remote-control-mount'
	let app: ReturnType<typeof createApp> | null = null
	let disposed = false

	import('./RemoteControlLayer.vue').then(({ default: RemoteControlLayer }) => {
		if (disposed || !connection) {
			return
		}
		app = createApp(RemoteControlLayer, {
			client: connection.client,
			peers: connection.peers,
			presenter: options.peerId,
			video: options.video,
			setControlled: options.setControlled,
		})
		app.mount(element)
	})

	return () => {
		disposed = true
		app?.unmount()
		element.remove()
		options.setControlled(false)
	}
}

/**
 * The API exposed to Talk as OCA.Talk.Desktop.remoteControl
 */
export const remoteControl = {
	attach,
	mountScreen,
}
