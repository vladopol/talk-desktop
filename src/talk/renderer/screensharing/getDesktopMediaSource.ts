/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type AppGetDesktopMediaSource from './AppGetDesktopMediaSource.vue'

import { createApp } from 'vue'
import { setPickedSourceId } from '../../../remote-control/talk/host.ts'

let appGetDesktopMediaSourceInstance: InstanceType<typeof AppGetDesktopMediaSource> | null = null

/**
 * Prompt user to select a desktop media source to share and return the selected sourceId or an empty string if canceled
 *
 * @return sourceId of the selected mediaSource or an empty string if canceled
 */
export async function getDesktopMediaSource() {
	if (!appGetDesktopMediaSourceInstance) {
		const { default: AppGetDesktopMediaSource } = await import('./AppGetDesktopMediaSource.vue')
		const container = document.body.appendChild(document.createElement('div'))
		appGetDesktopMediaSourceInstance = createApp(AppGetDesktopMediaSource).mount(container) as InstanceType<typeof AppGetDesktopMediaSource>
	}

	const result = await appGetDesktopMediaSourceInstance.promptDesktopMediaSource()
	// Remote control needs to know what is being shared
	setPickedSourceId(result.sourceId)
	return result
}
