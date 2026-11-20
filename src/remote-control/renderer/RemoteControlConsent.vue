<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script setup lang="ts">
import { t } from '@nextcloud/l10n'
import { onMounted, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
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

const subject = what === 'window'
	? (title ? t('talk_desktop', 'the window "{title}"', { title }) : t('talk_desktop', 'the shared window'))
	: what === 'desktop'
		? t('talk_desktop', 'all your screens')
		: t('talk_desktop', 'the shared screen')

const clipboard = ref(clipboardAvailable)
// The window pops up under the cursor of someone who is busy clicking
const enabled = ref(false)
const declineButton = ref<InstanceType<typeof NcButton> | null>(null)

onMounted(() => {
	setTimeout(() => {
		enabled.value = true
	}, enableDelay)
	;(declineButton.value?.$el as HTMLElement | undefined)?.focus()
})

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
	<AppWindow class="consent" @keydown="onKeyDown">
		<h2 class="consent__title">
			{{ t('talk_desktop', '{name} ({login}) asks to control {subject}', { name, login, subject }) }}
		</h2>
		<p>
			{{ t('talk_desktop', 'They will be able to use your mouse and keyboard. Moving your mouse pauses them, and you can take control back at any time.') }}
		</p>
		<p v-if="shortcutRegistered">
			{{ t('talk_desktop', 'To take control back, press Ctrl+Alt+Shift+Esc or use the banner at the top of the screen.') }}
		</p>
		<p v-else class="consent__warning">
			{{ t('talk_desktop', 'The shortcut Ctrl+Alt+Shift+Esc is taken by another application. Use the banner at the top of the screen to take control back.') }}
		</p>
		<p v-if="windowMode" class="consent__warning">
			{{ t('talk_desktop', 'Menus and dialogs of this application are not visible to them. Share the screen instead for full control.') }}
		</p>
		<NcCheckboxRadioSwitch v-if="clipboardAvailable" v-model="clipboard">
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
	</AppWindow>
</template>

<style scoped>
.consent {
	display: flex;
	flex-direction: column;
	gap: calc(2 * var(--default-grid-baseline));
	padding: calc(3 * var(--default-grid-baseline));
	background-color: var(--color-main-background);
	-webkit-app-region: drag;
}

.consent :deep(button),
.consent :deep(input),
.consent :deep(label) {
	-webkit-app-region: no-drag;
}

.consent__title {
	margin: 0;
	font-size: 1.1em;
	font-weight: bold;
}

.consent__warning {
	color: var(--color-warning-text);
}

.consent__actions {
	display: flex;
	justify-content: flex-end;
	gap: calc(2 * var(--default-grid-baseline));
	margin-top: auto;
}
</style>
