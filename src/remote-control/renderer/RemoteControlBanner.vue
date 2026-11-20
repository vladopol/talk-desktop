<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { BannerState } from '../remoteControl.window.ts'

import { t } from '@nextcloud/l10n'
import { computed, onBeforeUnmount, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import AppWindow from '../../shared/components/AppWindow.vue'

const state = ref<BannerState | null>(null)

window.TALK_DESKTOP.remoteControl.bannerState().then((initial: BannerState | null) => {
	state.value ??= initial
})
const unsubscribe = window.TALK_DESKTOP.remoteControl.on('banner', (value: BannerState) => {
	state.value = value
})
onBeforeUnmount(unsubscribe)

const text = computed(() => {
	if (!state.value) {
		return ''
	}
	const { name, login } = state.value
	if (state.value.state === 'paused') {
		switch (state.value.why) {
			case 'local-input':
				return t('talk_desktop', 'Paused while you use the mouse · {name} ({login})', { name, login })
			case 'window-hidden':
				return t('talk_desktop', 'Paused: the shared window is hidden · {name} ({login})', { name, login })
			default:
				return t('talk_desktop', 'Paused: connection lost · {name} ({login})', { name, login })
		}
	}
	return t('talk_desktop', 'Controlled by {name} ({login})', { name, login })
})

const clipboardNote = computed(() => {
	const note = state.value?.clipboard
	if (!note) {
		return ''
	}
	const [direction, size] = note.split(':')
	const sizeText = Number(size) < 1024 ? `${size} B` : `${(Number(size) / 1024).toFixed(1)} KB`
	return direction === 'in'
		? t('talk_desktop', 'Clipboard: {size} of text from {name}', { size: sizeText, name: state.value!.name })
		: t('talk_desktop', 'Clipboard: {size} of text to {name}', { size: sizeText, name: state.value!.name })
})

/**
 * @param action - A banner button
 */
function act(action: 'take-back' | 'bring-to-front') {
	window.TALK_DESKTOP.remoteControl.bannerAction(action)
}
</script>

<template>
	<AppWindow class="banner">
		<span class="banner__text">{{ clipboardNote || text }}</span>
		<NcButton
			v-if="state?.windowMode"
			size="small"
			variant="secondary"
			@click="act('bring-to-front')">
			{{ t('talk_desktop', 'Bring to front') }}
		</NcButton>
		<NcButton size="small" variant="error" @click="act('take-back')">
			{{ t('talk_desktop', 'Take back') }}
		</NcButton>
	</AppWindow>
</template>

<style scoped>
.banner {
	display: flex;
	align-items: center;
	gap: calc(2 * var(--default-grid-baseline));
	padding-inline: calc(3 * var(--default-grid-baseline));
	background-color: var(--color-warning);
	color: var(--color-warning-text, #000);
	border: 2px solid var(--color-error);
	-webkit-app-region: drag;
}

.banner :deep(button) {
	-webkit-app-region: no-drag;
}

.banner__text {
	flex: 1;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font-weight: bold;
}
</style>
