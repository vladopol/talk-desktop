<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { Peer } from './channel.ts'
import type { Client } from './client.ts'

import { t } from '@nextcloud/l10n'
import { computed, useId } from 'vue'
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

const tooltipId = `rc-call-button-tooltip-${useId()}`

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
	<!-- Its own tooltip: the native one from title did not show up in the call -->
	<div v-if="visible" class="rc-call-button">
		<NcButton
			:variant="inSession ? 'primary' : 'tertiary'"
			:disabled="!inSession && !canRequest"
			:aria-label="label"
			:aria-describedby="tooltipId"
			@click="onClick">
			<template #icon>
				<NcLoadingIcon v-if="requesting" :size="20" />
				<IconCursorDefaultClick v-else-if="inSession" :size="20" />
				<IconCursorDefaultClickOutline v-else :size="20" />
			</template>
		</NcButton>
		<span :id="tooltipId" role="tooltip" class="rc-call-button__tooltip">{{ label }}</span>
	</div>
</template>

<style scoped>
.rc-call-button {
	position: relative;
	display: inline-flex;
}

.rc-call-button__tooltip {
	position: absolute;
	bottom: calc(100% + var(--default-grid-baseline));
	inset-inline-start: 50%;
	transform: translateX(-50%);
	z-index: 100;
	width: max-content;
	max-width: 320px;
	padding: var(--default-grid-baseline) calc(2 * var(--default-grid-baseline));
	border-radius: var(--border-radius);
	background-color: var(--color-main-background);
	color: var(--color-main-text);
	box-shadow: 0 0 6px var(--color-box-shadow);
	font-size: var(--font-size-small, 13px);
	line-height: 1.3;
	text-align: center;
	pointer-events: none;
	opacity: 0;
	visibility: hidden;
	transition: opacity 0.15s, visibility 0.15s;
}

.rc-call-button:hover .rc-call-button__tooltip,
.rc-call-button:focus-within .rc-call-button__tooltip {
	opacity: 1;
	visibility: visible;
	transition-delay: 0.4s;
}
</style>
