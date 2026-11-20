/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Peer } from './channel.ts'
import type { ControlState } from './client.ts'

import { t } from '@nextcloud/l10n'

/**
 * Why the presenter's share cannot be controlled, or an empty string
 *
 * @param peer - What is known about the presenter's client
 */
export function getUnavailableReason(peer: Peer | undefined): string {
	const why = peer?.cap?.why
	switch (why) {
		case 'permission':
			return t('talk_desktop', 'The presenter has not allowed Talk to control their computer yet')
		case 'disabled':
			return t('talk_desktop', 'The presenter does not allow control')
		case 'wayland':
			return t('talk_desktop', 'The presenter uses Wayland, where control is not supported yet')
		case 'unsupported':
		case 'bindings':
			return t('talk_desktop', 'This screen share cannot be controlled')
		default:
			return ''
	}
}

/**
 * Why the last request was declined or the session ended, or an empty string
 *
 * @param state - The state of the presenter's screen
 */
export function getDeclineReason(state: ControlState): string {
	switch (state.why) {
		case 'user':
			return t('talk_desktop', 'The presenter declined or ended the control')
		case 'timeout':
			return t('talk_desktop', 'The presenter did not answer')
		case 'busy':
			return t('talk_desktop', 'The presenter is busy, try again later')
		case 'disabled':
			return t('talk_desktop', 'The presenter does not allow control')
		case 'unavailable':
			return t('talk_desktop', 'This screen share cannot be controlled')
		case 'share-ended':
		case 'window-closed':
			return t('talk_desktop', 'Control ended: the screen share has ended')
		case 'hb-lost':
			return t('talk_desktop', 'Control ended: the connection was lost')
		case null:
			return ''
		default:
			return t('talk_desktop', 'Control ended')
	}
}
