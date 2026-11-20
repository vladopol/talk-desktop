<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { Peer } from './channel.ts'
import type { Client } from './client.ts'

import { t } from '@nextcloud/l10n'
import { computed } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import IconCursorDefaultClick from 'vue-material-design-icons/CursorDefaultClick.vue'
import IconCursorDefaultClickOutline from 'vue-material-design-icons/CursorDefaultClickOutline.vue'
import { getUnavailableReason } from './reasons.ts'

/*
 * "Request control" in the call's bottom bar, next to the screen share and reactions buttons.
 * It is about the screen share shown big: the control layer over it tells the client whose it is.
 */

const props = defineProps<{
	client: Client
	peers: Map<string, Peer>
}>()

const presenter = computed(() => props.client.view.presenter)
const peer = computed(() => presenter.value ? props.peers.get(presenter.value) : undefined)
const state = computed(() => presenter.value ? props.client.state(presenter.value) : null)

const visible = computed(() => !!peer.value?.roles.includes('host') && !!peer.value.cap?.src)
const requesting = computed(() => state.value?.status === 'requesting')
const inSession = computed(() => ['active', 'paused', 'blocked', 'lost'].includes(state.value?.status ?? ''))
const canRequest = computed(() => state.value?.status === 'idle' && !!presenter.value && props.client.canRequest(presenter.value))

const label = computed(() => {
	if (inSession.value) {
		return t('talk_desktop', 'Stop control')
	}
	if (requesting.value) {
		return t('talk_desktop', 'Waiting for the presenter to allow control …')
	}
	return getUnavailableReason(peer.value) || t('talk_desktop', 'Request control')
})

/**
 * Request control, or stop it during a session
 */
function onClick() {
	if (!presenter.value) {
		return
	}
	if (inSession.value) {
		props.client.stop('user')
	} else {
		props.client.request(presenter.value)
	}
}
</script>

<template>
	<NcButton
		v-if="visible"
		:variant="inSession ? 'primary' : 'tertiary'"
		:disabled="!inSession && !canRequest"
		:aria-label="label"
		:title="label"
		@click="onClick">
		<template #icon>
			<NcLoadingIcon v-if="requesting" :size="20" />
			<IconCursorDefaultClick v-else-if="inSession" :size="20" />
			<IconCursorDefaultClickOutline v-else :size="20" />
		</template>
	</NcButton>
</template>
