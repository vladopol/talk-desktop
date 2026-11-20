<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import { t } from '@nextcloud/l10n'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import IconCursorDefaultClick from 'vue-material-design-icons/CursorDefaultClick.vue'
import AppWindow from '../../shared/components/AppWindow.vue'

const params = new URLSearchParams(window.location.search)
const name = params.get('name') ?? ''
const login = params.get('login') ?? ''
const what = params.get('what')
const title = params.get('title') ?? ''
const clipboardAvailable = params.get('clipboard') === 'true'
const shortcutRegistered = params.get('shortcut') === 'true'
const windowMode = params.get('windowMode') === 'true'
const enableDelay = Number(params.get('enableDelay')) || 1000

// Vue escapes the text itself, t() must not escape it once more
const noEscape = { escape: false }

const subject = what === 'window'
	? (title ? t('talk_desktop', 'the window "{title}"', { title }, undefined, noEscape) : t('talk_desktop', 'the shared window'))
	: what === 'desktop'
		? t('talk_desktop', 'all your screens')
		: t('talk_desktop', 'the shared screen')

const clipboard = ref(clipboardAvailable)
// The window pops up under the cursor of someone who is busy clicking
const enabled = ref(false)
const declineButton = ref<InstanceType<typeof NcButton> | null>(null)
const content = ref<HTMLElement | null>(null)

// The text differs in length by language and by what is shared: the window takes the
// height of its content instead of cutting the buttons off
const resizeObserver = new ResizeObserver(() => {
	if (content.value) {
		window.TALK_DESKTOP.remoteControl.resizeConsent(Math.ceil(content.value.getBoundingClientRect().height))
	}
})

onMounted(() => {
	setTimeout(() => {
		enabled.value = true
	}, enableDelay)
	;(declineButton.value?.$el as HTMLElement | undefined)?.focus()
	if (content.value) {
		resizeObserver.observe(content.value)
	}
})

onBeforeUnmount(() => resizeObserver.disconnect())

/**
 * @param allow - Whether to give control
 */
function answer(allow: boolean) {
	if (allow && !enabled.value) {
		return
	}
	window.TALK_DESKTOP.remoteControl.consentResult({ allow, clipboard: clipboard.value })
}

/**
 * Escape declines; Enter never accepts
 *
 * @param event - keydown
 */
function onKeyDown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		answer(false)
	} else if (event.key === 'Enter') {
		event.preventDefault()
	}
}
</script>

<template>
	<AppWindow class="consent-window" @keydown="onKeyDown">
		<div ref="content" class="consent">
			<div class="consent__header">
				<IconCursorDefaultClick class="consent__icon" :size="28" />
				<div class="consent__heading">
					<h2 class="consent__title">
						{{ t('talk_desktop', 'Request to control your computer') }}
					</h2>
					<div class="consent__who">
						<strong>{{ name }}</strong>
						<span class="consent__login">({{ login }})</span>
					</div>
				</div>
			</div>

			<p class="consent__text">
				{{ t('talk_desktop', 'Asks to control {subject} with your mouse and keyboard.', { subject }, undefined, noEscape) }}
				{{ t('talk_desktop', 'Moving your mouse pauses them, and you can take control back at any time.') }}
			</p>
			<p v-if="shortcutRegistered" class="consent__text consent__text--muted">
				{{ t('talk_desktop', 'To take control back, press Ctrl+Alt+Shift+Esc or use the banner at the top of the screen.') }}
			</p>

			<NcNoteCard v-if="!shortcutRegistered" type="warning" class="consent__note">
				{{ t('talk_desktop', 'The shortcut Ctrl+Alt+Shift+Esc is taken by another application. Use the banner at the top of the screen to take control back.') }}
			</NcNoteCard>
			<NcNoteCard v-if="windowMode" type="info" class="consent__note">
				{{ t('talk_desktop', 'Menus and dialogs of this application are not visible to them. Share the screen instead for full control.') }}
			</NcNoteCard>

			<NcCheckboxRadioSwitch v-if="clipboardAvailable" v-model="clipboard" class="consent__clipboard">
				{{ t('talk_desktop', 'Shared clipboard (text)') }}
			</NcCheckboxRadioSwitch>

			<div class="consent__actions">
				<NcButton ref="declineButton" variant="secondary" @click="answer(false)">
					{{ t('talk_desktop', 'Decline') }}
				</NcButton>
				<NcButton variant="primary" :disabled="!enabled" @click="answer(true)">
					{{ t('talk_desktop', 'Allow') }}
				</NcButton>
			</div>
		</div>
	</AppWindow>
</template>

<style scoped>
.consent-window {
	background-color: var(--color-main-background);
	/* The window has no frame: it is moved by its body */
	-webkit-app-region: drag;
	overflow: hidden;
}

.consent-window :deep(button),
.consent-window :deep(input),
.consent-window :deep(label) {
	-webkit-app-region: no-drag;
}

.consent {
	display: flex;
	flex-direction: column;
	gap: calc(2 * var(--default-grid-baseline));
	padding: calc(4 * var(--default-grid-baseline));
}

.consent__header {
	display: flex;
	align-items: center;
	gap: calc(3 * var(--default-grid-baseline));
}

.consent__icon {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 48px;
	height: 48px;
	border-radius: 50%;
	background-color: var(--color-primary-element-light);
	color: var(--color-primary-element-light-text);
}

.consent__heading {
	min-width: 0;
}

.consent__title {
	margin: 0;
	font-size: calc(var(--default-font-size) * 1.15);
	font-weight: bold;
	line-height: 1.3;
}

.consent__who {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--default-grid-baseline);
	overflow-wrap: anywhere;
}

.consent__login {
	color: var(--color-text-maxcontrast);
}

.consent__text {
	margin: 0;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.consent__text--muted {
	color: var(--color-text-maxcontrast);
}

.consent__note {
	margin: 0 !important;
}

.consent__clipboard {
	margin-inline-start: calc(-1 * var(--default-grid-baseline));
}

.consent__actions {
	display: flex;
	justify-content: flex-end;
	gap: calc(2 * var(--default-grid-baseline));
	padding-top: var(--default-grid-baseline);
}
</style>
