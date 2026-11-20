<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { Peer } from './channel.ts'
import type { Client, ControlState } from './client.ts'

import { t } from '@nextcloud/l10n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import IconClipboardArrowUpOutline from 'vue-material-design-icons/ClipboardArrowUpOutline.vue'
import IconStop from 'vue-material-design-icons/Stop.vue'
import { getDeclineReason, getUnavailableReason } from './reasons.ts'

const props = defineProps<{
	client: Client
	peers: Map<string, Peer>
	presenter: string
	video: HTMLVideoElement
	setControlled: (controlled: boolean) => void
}>()

const surface = ref<HTMLElement | null>(null)
const focused = ref(false)

const state = computed<ControlState>(() => props.client.state(props.presenter))
const peer = computed(() => props.peers.get(props.presenter))
const inSession = computed(() => ['active', 'paused', 'blocked', 'lost'].includes(state.value.status))
const showRequest = computed(() => state.value.status === 'idle' && !!peer.value?.roles.includes('host') && !!peer.value.cap?.src)
const isMac = window.systemInfo?.isMac

const unavailableReason = computed(() => getUnavailableReason(peer.value))
const declineReason = computed(() => getDeclineReason(state.value))

const stateHint = computed(() => {
	if (state.value.status === 'lost') {
		return t('talk_desktop', 'Connection lost, waiting for the presenter …')
	}
	if (state.value.status !== 'paused' && state.value.status !== 'blocked') {
		return ''
	}
	switch (state.value.why) {
		case 'local-input':
			return t('talk_desktop', 'The presenter took over the mouse')
		case 'window-hidden':
			return t('talk_desktop', 'The shared window is minimized or on another desktop')
		case 'window-occluded':
			return t('talk_desktop', 'The window is covered by another one on the presenter\'s screen')
		case 'focus-elsewhere':
			return t('talk_desktop', 'Click into the shared window to type')
		case 'own-window':
			return t('talk_desktop', 'Talk windows on the presenter\'s screen cannot be controlled')
		case 'outside':
			return t('talk_desktop', 'This point is outside of the presenter\'s screens')
		case 'resizing':
			return t('talk_desktop', 'The window is being resized')
		case 'hb-lost':
			return t('talk_desktop', 'Connection lost, waiting for the controller …')
		default:
			return ''
	}
})

const mapLabel = computed(() => isMac
	? t('talk_desktop', 'Use Cmd as Ctrl')
	: t('talk_desktop', 'Use Ctrl as Cmd'))

const mapModifiers = computed({
	get: () => state.value.mapModifiers,
	set: (value: boolean) => props.client.setMapModifiers(props.presenter, value),
})

watch(inSession, (value) => {
	props.setControlled(value)
	if (value) {
		props.client.frame(props.video.videoWidth, props.video.videoHeight)
	}
}, { immediate: true })

/**
 * The position of a mouse event in the shown frame, 0…1. The video is shown with
 * object-fit: contain, possibly zoomed by Talk before control started; the content is
 * the letterboxed rectangle inside the transformed element.
 *
 * @param event - Mouse event
 * @return The position, or null over the bars around the frame
 */
function toFrame(event: MouseEvent): { x: number, y: number, inside: boolean } | null {
	const { videoWidth, videoHeight } = props.video
	if (!videoWidth || !videoHeight) {
		return null
	}
	const rect = props.video.getBoundingClientRect()
	const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
	const width = videoWidth * scale
	const height = videoHeight * scale
	const left = rect.left + (rect.width - width) / 2
	const top = rect.top + (rect.height - height) / 2
	const x = (event.clientX - left) / width
	const y = (event.clientY - top) / height
	const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1
	return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1), inside }
}

/** Buttons held on the surface, to clamp drags leaving the frame */
const heldButtons = new Set<number>()
// Where the last button-up of a lost capture goes: the point the cursor was last sent to
let lastPoint = { x: 0, y: 0 }

/**
 * @param event - mousemove
 */
function onMouseMove(event: MouseEvent) {
	const point = toFrame(event)
	if (point && (point.inside || heldButtons.size > 0)) {
		lastPoint = { x: point.x, y: point.y }
		props.client.move(point.x, point.y)
	}
}

/**
 * @param event - pointerdown, only to capture the pointer
 */
function onPointerDown(event: PointerEvent) {
	surface.value?.setPointerCapture(event.pointerId)
}

/**
 * @param event - mousedown
 */
function onMouseDown(event: MouseEvent) {
	event.preventDefault()
	event.stopPropagation()
	surface.value?.focus()
	const point = toFrame(event)
	// Clicks on the bars around the frame are not sent
	if (!point?.inside) {
		return
	}
	heldButtons.add(event.button)
	lastPoint = { x: point.x, y: point.y }
	props.client.button(event.button, true, point.x, point.y, event.detail)
}

/**
 * @param event - mouseup
 */
function onMouseUp(event: MouseEvent) {
	// The back and forward buttons would navigate the Talk window
	event.preventDefault()
	event.stopPropagation()
	if (!heldButtons.delete(event.button)) {
		return
	}
	const point = toFrame(event)
	props.client.button(event.button, false, point?.x ?? 0, point?.y ?? 0, event.detail)
}

/**
 * @param event - wheel
 */
function onWheel(event: WheelEvent) {
	event.preventDefault()
	event.stopPropagation()
	const point = toFrame(event)
	if (!point?.inside) {
		return
	}
	// To 1/120 of a notch: a notch is about 100 px in Chromium, a line about 3 per notch
	const factor = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1.2 : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : 360
	props.client.wheel(event.deltaX * factor, event.deltaY * factor, point.x, point.y, event.ctrlKey)
}

/**
 * The capture is also lost after every normal mouseup. Only a capture lost with a button still
 * held (the window lost the pointer mid-drag) releases those buttons, and only them: held keys
 * stay, so Ctrl+click works more than once. Checked after the task, when a mouseup in flight has
 * already been handled.
 */
function onLostPointerCapture() {
	setTimeout(() => {
		for (const button of heldButtons) {
			props.client.button(button, false, lastPoint.x, lastPoint.y, 0)
		}
		heldButtons.clear()
	})
}

/**
 * Release everything when the surface loses the focus
 */
function release() {
	heldButtons.clear()
	props.client.release()
}

/**
 * @param event - Any event that must not reach Talk below
 */
function swallow(event: Event) {
	event.preventDefault()
	event.stopPropagation()
}

const onResize = () => props.client.frame(props.video.videoWidth, props.video.videoHeight)
/**
 *
 */
function onWindowBlur() {
	release()
	props.client.setFocused(false)
}
const onVisibilityChange = () => document.hidden && onWindowBlur()

onMounted(() => {
	props.client.attach(props.presenter)
	props.video.addEventListener('resize', onResize)
	window.addEventListener('blur', onWindowBlur)
	document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
	props.video.removeEventListener('resize', onResize)
	window.removeEventListener('blur', onWindowBlur)
	document.removeEventListener('visibilitychange', onVisibilityChange)
	props.client.setFocused(false)
	props.client.attach(null)
})

/**
 * @param value - Whether the surface has the focus
 */
function setFocused(value: boolean) {
	focused.value = value
	props.client.setFocused(value)
}
</script>

<template>
	<div class="remote-control">
		<div
			v-if="inSession"
			ref="surface"
			class="remote-control__surface"
			:class="{ 'remote-control__surface--focused': focused }"
			tabindex="0"
			@mousemove="onMouseMove"
			@pointerdown="onPointerDown"
			@mousedown="onMouseDown"
			@mouseup="onMouseUp"
			@auxclick="swallow"
			@click="swallow"
			@dblclick="swallow"
			@contextmenu="swallow"
			@wheel="onWheel"
			@lostpointercapture="onLostPointerCapture"
			@focus="setFocused(true)"
			@blur="setFocused(false)" />

		<div class="remote-control__toolbar">
			<!-- The request button is in the call's bottom bar, the reason stays next to the screen -->
			<span v-if="showRequest && (unavailableReason || declineReason)" class="remote-control__hint">
				{{ unavailableReason || declineReason }}
			</span>

			<span v-else-if="state.status === 'requesting'" class="remote-control__hint">
				{{ t('talk_desktop', 'Waiting for the presenter to allow control …') }}
			</span>

			<template v-else-if="inSession">
				<NcButton variant="error" @click="client.stop('user')">
					<template #icon>
						<IconStop :size="20" />
					</template>
					{{ t('talk_desktop', 'Stop control') }}
				</NcButton>
				<NcButton
					v-if="state.clipboard"
					variant="secondary"
					:title="t('talk_desktop', 'Send your clipboard to the presenter, to paste it through a menu')"
					@click="client.sendLocalClipboard()">
					<template #icon>
						<IconClipboardArrowUpOutline :size="20" />
					</template>
				</NcButton>
				<NcCheckboxRadioSwitch
					v-if="client.osDiffers(presenter)"
					v-model="mapModifiers"
					type="switch"
					class="remote-control__switch">
					{{ mapLabel }}
				</NcCheckboxRadioSwitch>
				<span v-if="stateHint" class="remote-control__hint remote-control__hint--warning">
					{{ stateHint }}
				</span>
				<span v-else-if="!focused" class="remote-control__hint">
					{{ t('talk_desktop', 'Click on the screen to type') }}
				</span>
				<span v-else-if="state.clipboardIn !== null" class="remote-control__hint">
					{{ t('talk_desktop', 'Copied from the presenter\'s computer') }}
				</span>
			</template>
		</div>

		<div v-if="inSession && state.src === 'window'" class="remote-control__window-hint">
			{{ t('talk_desktop', 'Menus and dialogs of this application are not visible to you. Ask to share the screen for full control.') }}
		</div>
	</div>
</template>

<style scoped>
.remote-control {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 5;
}

.remote-control__surface {
	position: absolute;
	inset: 0;
	pointer-events: auto;
	outline: 3px solid var(--color-warning);
	outline-offset: -3px;
	/* The local cursor stays visible: the remote one arrives with the video latency */
	cursor: default;
}

.remote-control__surface--focused {
	outline-color: var(--color-error);
}

.remote-control__toolbar {
	position: absolute;
	top: calc(2 * var(--default-grid-baseline));
	inset-inline-end: calc(2 * var(--default-grid-baseline));
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: calc(2 * var(--default-grid-baseline));
	max-width: 70%;
	pointer-events: auto;
}

.remote-control__hint {
	padding: calc(var(--default-grid-baseline)) calc(2 * var(--default-grid-baseline));
	border-radius: var(--border-radius-element, var(--border-radius-large));
	background-color: rgba(0, 0, 0, 0.6);
	color: #fff;
}

.remote-control__hint--warning {
	background-color: var(--color-warning);
	color: var(--color-warning-text, #000);
}

.remote-control__switch {
	padding-inline: calc(var(--default-grid-baseline));
	border-radius: var(--border-radius-element, var(--border-radius-large));
	background-color: rgba(0, 0, 0, 0.6);
	color: #fff;
}

.remote-control__window-hint {
	position: absolute;
	bottom: calc(2 * var(--default-grid-baseline));
	inset-inline-start: 50%;
	transform: translateX(-50%);
	padding: calc(var(--default-grid-baseline)) calc(2 * var(--default-grid-baseline));
	border-radius: var(--border-radius-element, var(--border-radius-large));
	background-color: rgba(0, 0, 0, 0.6);
	color: #fff;
	pointer-events: none;
}
</style>
