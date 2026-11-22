<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { BannerState } from '../remoteControl.window.ts'

import { t } from '@nextcloud/l10n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
	const { name } = state.value
	if (state.value.state === 'paused') {
		switch (state.value.why) {
			case 'local-input':
				return t('talk_desktop', 'Paused while you use the mouse · {name}', { name }, undefined, { escape: false })
			case 'window-hidden':
				return t('talk_desktop', 'Paused: the shared window is hidden · {name}', { name }, undefined, { escape: false })
			default:
				return t('talk_desktop', 'Paused: connection lost · {name}', { name }, undefined, { escape: false })
		}
	}
	if (state.value.elevated) {
		return t('talk_desktop', '{name} cannot control administrator windows · minimize it', { name }, undefined, { escape: false })
	}
	return t('talk_desktop', 'Controlled by {name}', { name }, undefined, { escape: false })
})

const clipboardNote = computed(() => {
	const note = state.value?.clipboard
	if (!note) {
		return ''
	}
	const [direction, size] = note.split(':')
	const sizeText = Number(size) < 1024 ? `${size} B` : `${(Number(size) / 1024).toFixed(1)} KB`
	return direction === 'in'
		? t('talk_desktop', 'Clipboard: {size} of text from {name}', { size: sizeText, name: state.value!.name }, undefined, { escape: false })
		: t('talk_desktop', 'Clipboard: {size} of text to {name}', { size: sizeText, name: state.value!.name }, undefined, { escape: false })
})

// The banner takes the width of its content: names and translations differ in length.
// The content is measured, not the window: the window follows the measure, and measuring
// what follows the window would grow it without end.
const BORDER_WIDTH = 2
const content = ref<HTMLElement | null>(null)

/**
 * Ask the main process to fit the window to the content
 */
function resize() {
	if (content.value) {
		window.TALK_DESKTOP.remoteControl.resizeBanner(Math.ceil(content.value.getBoundingClientRect().width) + 2 * BORDER_WIDTH)
	}
}
const resizeObserver = new ResizeObserver(resize)
onMounted(() => {
	if (content.value) {
		resizeObserver.observe(content.value)
	}
})
onBeforeUnmount(() => resizeObserver.disconnect())
watch(state, () => nextTick(resize))

/**
 * @param action - A banner button
 */
function act(action: 'take-back' | 'bring-to-front') {
	window.TALK_DESKTOP.remoteControl.bannerAction(action)
}
</script>

<template>
	<AppWindow class="banner">
		<div ref="content" class="banner__content">
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
		</div>
	</AppWindow>
</template>

<style scoped>
.banner {
	display: flex;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	background-color: var(--color-warning);
	color: var(--color-warning-text, #000);
	border: 2px solid var(--color-error);
	-webkit-app-region: drag;
}

.banner__content {
	display: inline-flex;
	flex-shrink: 0;
	width: max-content;
	align-items: center;
	gap: calc(2 * var(--default-grid-baseline));
	padding-inline: calc(3 * var(--default-grid-baseline));
}

.banner :deep(button) {
	-webkit-app-region: no-drag;
}

.banner__text {
	max-width: 600px;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	font-weight: bold;
}
</style>
