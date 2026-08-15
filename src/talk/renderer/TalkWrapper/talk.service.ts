/*
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Router } from 'vue-router'

import { isNavigationFailure, NavigationFailureType } from '@talk/node_modules/vue-router'
import { useTalkHashStore } from '@talk/src/stores/talkHash.js'
import { logIssue1777Origin } from '@talk/src/utils/issue1777Debug.ts'

/**
 * Get the Talk instance
 */
function getTalkInstance() {
	if (!window.OCA.Talk?.instance) {
		throw new Error('Talk is not initialized yet or not available')
	}
	return window.OCA.Talk.instance
}

/**
 * Get the Talk router
 */
function getTalkRouter(): Router {
	return getTalkInstance().$router
}

/**
 * Get the current Talk route path
 */
export function getCurrentTalkRoutePath() {
	return getTalkRouter().currentRoute.value.fullPath
}

/**
 * Open the Talk root
 */
export function openRoot() {
	getTalkRouter().push({ name: 'root' }).catch(passDuplicatedNavigationError)
}

/**
 * Open a conversation in Talk
 *
 * @param token - Conversation token
 * @param options - Options
 * @param options.directCall - Use direct call (open media settings to join a call)
 */
export async function openConversation(token: string, { directCall = false }: { directCall?: boolean } = {}) {
	// Origin of the suspected chain in #1777: accepting an incoming call pushes a
	// history entry carrying '#direct-call'. Recorded in the non-evictable ring
	// because the auto-call may follow tens of minutes later.
	logIssue1777Origin('talk-desktop openConversation', {
		token,
		directCall,
		hashPushed: directCall ? '#direct-call' : undefined,
		currentPath: getTalkRouter().currentRoute.value.fullPath,
	}, true)

	await getTalkRouter().push({
		name: 'conversation',
		params: { token },
		hash: directCall ? '#direct-call' : undefined,
	}).then(() => {
		logIssue1777Origin('talk-desktop openConversation push resolved', { token, directCall })
	}).catch((error) => {
		logIssue1777Origin('talk-desktop openConversation push REJECTED', {
			token,
			directCall,
			duplicated: isNavigationFailure(error, NavigationFailureType.duplicated),
			error: String(error),
		}, true)
		passDuplicatedNavigationError(error as Error)
	})

	await window.TALK_DESKTOP.focusTalk()
}

/**
 * Ignore duplicated navigation error
 *
 * @param error - Error
 */
function passDuplicatedNavigationError(error: Error) {
	if (!isNavigationFailure(error, NavigationFailureType.duplicated)) {
		throw error
	}
}

type TalkHashStoreAdapter = {
	/** Set Nextcloud Talk hash */
	setTalkHash: (hash: string) => void
	/** Listen to Nextcloud Talk update */
	onUpdate: (callback: (hash: string) => void) => void
	/** Listen to Nextcloud Talk hash set dirty */
	onDirty: (callback: () => void) => void
}

/**
 * Create a Talk hash store adapter
 */
function createTalkHashStoreAdapter(): TalkHashStoreAdapter {
	const talkHashStore = useTalkHashStore(getTalkInstance().$pinia)

	let onDirty: Parameters<TalkHashStoreAdapter['onDirty']>[0]
	let onUpdate: Parameters<TalkHashStoreAdapter['onUpdate']>[0]

	talkHashStore.$onAction(({ name, after }: { name: string, after: (callback: () => void) => void }) => {
		if (name !== 'setNextcloudTalkHash') {
			return
		}
		after(() => {
			if (talkHashStore.isNextcloudTalkHashDirty) {
				onDirty?.()
			} else {
				onUpdate?.(talkHashStore.initialNextcloudTalkHash)
			}
		})
	})

	return {
		setTalkHash: (hash) => talkHashStore.setNextcloudTalkHash(hash),
		onDirty: (callback) => {
			onDirty = callback
		},
		onUpdate: (callback) => {
			onUpdate = callback
		},
	}
}

let talkHashStoreAdapter: TalkHashStoreAdapter | null = null

/**
 * Get the Talk hash store adapter singleton
 */
function getTalkHashStoreAdapter() {
	if (!talkHashStoreAdapter) {
		talkHashStoreAdapter = createTalkHashStoreAdapter()
	}
	return talkHashStoreAdapter
}

/**
 * Set the Talk hash
 *
 * @param hash - Talk Hash
 */
export function setTalkHash(hash: string) {
	getTalkHashStoreAdapter().setTalkHash(hash)
}

/**
 * Listen to Talk hash update
 *
 * @param callback - Callback
 */
export function onTalkHashUpdate(callback: (hash: string) => void) {
	getTalkHashStoreAdapter().onUpdate(callback)
}

/**
 * Listen to Talk hash dirty
 *
 * @param callback - Callback
 */
export function onTalkHashDirty(callback: () => void) {
	getTalkHashStoreAdapter().onDirty(callback)
}
