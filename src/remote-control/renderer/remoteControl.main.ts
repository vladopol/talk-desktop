/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createApp } from 'vue'
import { setupWebPage } from '../../shared/setupWebPage.js'

import '../../shared/assets/styles.css'

await setupWebPage()

const mode = new URLSearchParams(window.location.search).get('mode')

const { default: App } = mode === 'banner'
	? await import('./RemoteControlBanner.vue')
	: await import('./RemoteControlConsent.vue')

createApp(App).mount('#app')
