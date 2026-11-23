<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import type { ShallowRef } from 'vue'
import type { Peer } from './channel.ts'
import type { Client, ControlState } from './client.ts'

import { t } from '@nextcloud/l10n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import IconChevronDown from 'vue-material-design-icons/ChevronDown.vue'
import IconClipboardArrowUpOutline from 'vue-material-design-icons/ClipboardArrowUpOutline.vue'
import IconStop from 'vue-material-design-icons/Stop.vue'
import IconSwapHorizontal from 'vue-material-design-icons/SwapHorizontal.vue'
import { getDeclineReason, getUnavailableReason } from './reasons.ts'

const props = defineProps<{
	client: Client
	peers: Map<string, Peer>
	presenter: string
	video: HTMLVideoElement
	setControlled: (controlled: boolean) => void
	/** The mount point in the call's top bar, when the call shows one */
	toolbarSlot: ShallowRef<HTMLElement | null>
}>()

const topBar = computed(() => props.toolbarSlot.value)
/** Without the top bar the toolbar hides behind a tab over the screen, open while pinned */
const toolbarOpen = ref(false)

const root = ref<HTMLElement | null>(null)
/** The tab hangs from the top edge of the frame, 10 % of its width from its right edge */
const dockStyle = ref<Record<string, string>>({})

/**
 * Place the tab on the shown frame: the video is letterboxed, the frame is not the element
 */
function placeDock() {
	const { videoWidth, videoHeight } = props.video
	if (!root.value || !videoWidth || !videoHeight) {
		dockStyle.value = {}
		return
	}
	const rect = props.video.getBoundingClientRect()
	const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight)
	const width = videoWidth * scale
	const frameRight = rect.right - (rect.width - width) / 2
	const frameTop = rect.top + (rect.height - videoHeight * scale) / 2
	const rootRect = root.value.getBoundingClientRect()
	dockStyle.value = {
		top: `${Math.max(frameTop - rootRect.top, 0)}px`,
		right: `${Math.max(rootRect.right - frameRight + width * 0.1, 0)}px`,
	}
}
const videoResizeObserver = new ResizeObserver(placeDock)

const surface = ref<HTMLElement | null>(null)
const focused = ref(false)

const state = computed<ControlState>(() => props.client.state(props.presenter))
const peer = computed(() => props.peers.get(props.presenter))
const inSession = computed(() => ['active', 'paused', 'blocked', 'lost'].includes(state.value.status))
const showRequest = computed(() => state.value.status === 'idle' && !!peer.value?.roles.includes('host') && !!peer.value.cap?.src)
const isMac = window.systemInfo?.isMac

const unavailableReason = computed(() => getUnavailableReason(peer.value))
const declineReason = computed(() => getDeclineReason(state.value))
/** Whether the toolbar has anything to show */
const hasToolbar = computed(() => inSession.value || state.value.status === 'requesting' || (showRequest.value && !!(unavailableReason.value || declineReason.value)))

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
		case 'elevated':
			return t('talk_desktop', 'This window runs as administrator: Windows does not let it be controlled. Click "Switch window" or the taskbar')
		case 'elevated-failed':
			return t('talk_desktop', 'Could not switch away from the administrator window. Ask the presenter to minimize it')
		default:
			return ''
	}
})

const showLeaveElevated = computed(() => state.value.status === 'blocked' && (state.value.why === 'elevated' || state.value.why === 'elevated-failed'))

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

/**
 *
 */
function onResize() {
	props.client.frame(props.video.videoWidth, props.video.videoHeight)
	placeDock()
}
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
	videoResizeObserver.observe(props.video)
	window.addEventListener('blur', onWindowBlur)
	document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
	props.video.removeEventListener('resize', onResize)
	videoResizeObserver.disconnect()
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
	<div ref="root" class="remote-control">
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

		<!-- In the call's top bar, out of the shared screen; over the screen when the call has no top bar -->
		<div class="remote-control__dock" :style="dockStyle">
			<button
				v-if="!topBar && hasToolbar"
				type="button"
				class="remote-control__tab"
				:class="{ 'remote-control__tab--open': toolbarOpen, 'remote-control__tab--warning': stateHint && !toolbarOpen }"
				:aria-expanded="toolbarOpen"
				:aria-label="toolbarOpen ? t('talk_desktop', 'Hide remote control') : t('talk_desktop', 'Show remote control')"
				:title="!toolbarOpen && stateHint ? stateHint : undefined"
				@click="toolbarOpen = !toolbarOpen">
				<span v-if="inSession" class="remote-control__tab-dot" />
				<IconChevronDown class="remote-control__tab-chevron" :size="18" />
			</button>
			<Teleport :to="topBar ?? 'body'" :disabled="!topBar">
				<Transition name="remote-control-slide">
					<div
						v-show="topBar || toolbarOpen"
						class="remote-control__toolbar"
						:class="topBar ? 'remote-control__toolbar--top-bar' : 'remote-control__toolbar--floating'">
						<!-- The request button is in the call's bottom bar, the reason goes with the toolbar -->
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
								v-if="showLeaveElevated"
								variant="primary"
								:title="t('talk_desktop', 'Bring an ordinary window to the front on the presenter\'s screen, or minimize the administrator window')"
								@click="client.leaveElevated()">
								<template #icon>
									<IconSwapHorizontal :size="20" />
								</template>
								{{ t('talk_desktop', 'Switch window') }}
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
							<span v-if="stateHint" class="remote-control__hint remote-control__hint--warning" :title="stateHint">
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
				</Transition>
			</Teleport>
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

/* At the right, away from the corner with the window buttons and from the presenter's banner in
   the middle; placeDock() puts it on the frame */
.remote-control__dock {
	position: absolute;
	top: 0;
	right: 10%;
	display: flex;
	justify-content: center;
	pointer-events: none;
}

.remote-control__tab {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--default-grid-baseline);
	min-width: 56px;
	height: 20px;
	padding: 0 calc(2 * var(--default-grid-baseline));
	border: none;
	border-radius: 0 0 var(--border-radius-large) var(--border-radius-large);
	background-color: rgba(0, 0, 0, 0.6);
	color: #fff;
	cursor: pointer;
	pointer-events: auto;
	transition: background-color 200ms ease-in-out;
}

.remote-control__tab:hover,
.remote-control__tab:focus-visible {
	background-color: rgba(0, 0, 0, 0.8);
}

.remote-control__tab--warning {
	background-color: var(--color-warning);
	color: var(--color-warning-text, #000);
}

.remote-control__tab--warning:hover,
.remote-control__tab--warning:focus-visible {
	background-color: var(--color-warning-hover, var(--color-warning));
}

.remote-control__tab-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background-color: var(--color-error);
}

.remote-control__tab-chevron {
	transition: transform 200ms ease-in-out;
}

.remote-control__tab--open .remote-control__tab-chevron {
	transform: rotate(180deg);
}

.remote-control__toolbar--floating {
	top: 100%;
	right: 0;
	width: max-content;
	max-width: 80vw;
	justify-content: flex-end;
	margin-top: var(--default-grid-baseline);
}

.remote-control-slide-enter-active,
.remote-control-slide-leave-active {
	transition: transform 200ms ease-in-out, opacity 200ms ease-in-out;
}

.remote-control-slide-enter-from,
.remote-control-slide-leave-to {
	transform: translateY(-8px);
	opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
	.remote-control__tab,
	.remote-control__tab-chevron,
	.remote-control-slide-enter-active,
	.remote-control-slide-leave-active {
		transition: none;
	}
}

.remote-control__toolbar--top-bar {
	position: static;
	flex-wrap: nowrap;
	max-width: 100%;
	min-width: 0;
}

.remote-control__toolbar--top-bar .remote-control__hint {
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
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
