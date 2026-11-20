<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { Peer } from './channel.ts'
import type { Client } from './client.ts'

import { t } from '@nextcloud/l10n'
import { computed, onBeforeUnmount, ref, useId } from 'vue'
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

// The tooltip lives in <body>: inside the bottom bar it was under the presenter's name over
// the screen share, whatever its z-index. Native title tooltips do not show up on macOS.
const wrapper = ref<HTMLElement | null>(null)
const tooltip = ref<{ left: number, bottom: number } | null>(null)
let tooltipTimer: number | undefined

/**
 * Show the tooltip above the button after a short hover
 */
function showTooltip() {
	clearTimeout(tooltipTimer)
	tooltipTimer = window.setTimeout(() => {
		const rect = wrapper.value?.getBoundingClientRect()
		if (rect) {
			tooltip.value = { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 6 }
		}
	}, 400)
}

/**
 * Hide the tooltip
 */
function hideTooltip() {
	clearTimeout(tooltipTimer)
	tooltip.value = null
}

onBeforeUnmount(hideTooltip)

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
	<!-- Its own tooltip: native title tooltips do not show up on macOS -->
	<div
		v-if="visible"
		ref="wrapper"
		class="rc-call-button"
		@mouseenter="showTooltip"
		@mouseleave="hideTooltip"
		@focusin="showTooltip"
		@focusout="hideTooltip"
		@click="hideTooltip">
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
		<Teleport to="body">
			<span
				v-show="tooltip"
				:id="tooltipId"
				role="tooltip"
				class="rc-call-button__tooltip"
				:style="tooltip ? { left: `${tooltip.left}px`, bottom: `${tooltip.bottom}px` } : undefined">
				{{ label }}
			</span>
		</Teleport>
	</div>
</template>

<style scoped>
.rc-call-button {
	position: relative;
	display: inline-flex;
}

/* A disabled button swallows the hover: let it reach the wrapper, which shows the reason */
.rc-call-button :deep(button:disabled) {
	pointer-events: none;
}

.rc-call-button__tooltip {
	position: fixed;
	transform: translateX(-50%);
	z-index: 100000;
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
}
</style>
