/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Rectangle } from 'electron'

import { BrowserWindow, ipcMain, screen } from 'electron'
import { getAppConfig } from '../app/AppConfig.ts'
import { isMac, isWindows } from '../app/system.utils.ts'
import { applyZoom, getScaledWindowSize, getWindowUrl, onReadyToShow } from '../app/utils.ts'
import { BUILD_CONFIG } from '../shared/build.config.ts'
import { getBrowserWindowIcon } from '../shared/icons.utils.js'
import { LIMITS } from './protocol.ts'

export type ConsentParams = {
	/** Display name, as set by the user themselves */
	name: string
	/** Login, from the server-set sender of the request */
	login: string
	/** What will be controlled: "screen", "desktop" or "window", plus the window title */
	what: 'desktop' | 'screen' | 'window'
	title: string
	/** Whether the clipboard checkbox is shown */
	clipboard: boolean
	/** Whether the revoke shortcut could be registered */
	shortcut: boolean
	/** Window mode: menus and dialogs are not visible to the controller */
	windowMode: boolean
}

export type ConsentResult = { allow: boolean, clipboard: boolean, why: 'user' | 'timeout' | 'closed' }

export type BannerAction = 'take-back' | 'bring-to-front'

export type BannerState = {
	name: string
	login: string
	windowMode: boolean
	state: 'active' | 'paused' | 'blocked'
	why: string | null
	clipboard: string | null
}

let consentWindow: BrowserWindow | null = null
let bannerWindow: BrowserWindow | null = null
let bannerState: BannerState | null = null
let bannerActionHandler: ((action: BannerAction) => void) | null = null

/**
 * Create a small frameless window of the remote control entry point
 *
 * @param mode - What the window shows
 * @param size - Content size in DIP before zoom
 * @param size.width
 * @param size.height
 * @param params - Query parameters for the page
 */
function createWindow(mode: 'consent' | 'banner', size: { width: number, height: number }, params: Record<string, string>) {
	const { width, height } = getScaledWindowSize(size)
	const window = new BrowserWindow({
		width,
		height,
		acceptFirstMouse: mode === 'banner',
		alwaysOnTop: true,
		autoHideMenuBar: true,
		backgroundColor: BUILD_CONFIG.backgroundColor,
		frame: false,
		fullscreenable: false,
		icon: getBrowserWindowIcon(),
		maximizable: false,
		minimizable: false,
		resizable: false,
		show: false,
		skipTaskbar: mode === 'banner',
		titleBarStyle: 'hidden',
		type: isWindows ? 'toolbar' : isMac ? 'panel' : 'normal',
		webPreferences: {
			preload: TALK_DESKTOP__WINDOW_REMOTE_CONTROL_PRELOAD_WEBPACK_ENTRY,
			zoomFactor: getAppConfig('zoomFactor'),
		},
	})
	window.removeMenu()
	// Above full-screen applications, like the screensharing indicator
	window.setAlwaysOnTop(true, 'screen-saver')
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	applyZoom(window)
	window.loadURL(getWindowUrl('remote_control') + '?' + new URLSearchParams({ mode, ...params }))
	return window
}

/**
 * Center a rectangle of the given size horizontally on the display under the cursor
 *
 * @param window - The window to place
 * @param top - Whether to place at the top edge instead of the center
 */
function placeOnCursorDisplay(window: BrowserWindow, top: boolean) {
	const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	const [width, height] = window.getSize() as [number, number]
	const bounds: Rectangle = {
		x: Math.round(workArea.x + (workArea.width - width) / 2),
		y: top ? workArea.y + 8 : Math.round(workArea.y + (workArea.height - height) / 2),
		width,
		height,
	}
	window.setBounds(bounds)
}

/**
 * Ask the local user whether to give control. At most one such window exists at a time.
 * Declines on its own after LIMITS.CONSENT_TIMEOUT.
 *
 * @param params - What to show
 */
export function showConsentWindow(params: ConsentParams): Promise<ConsentResult> {
	closeConsentWindow()

	const window = createWindow('consent', { width: 460, height: params.windowMode ? 300 : 240 }, {
		name: params.name,
		login: params.login,
		what: params.what,
		title: params.title,
		clipboard: String(params.clipboard),
		shortcut: String(params.shortcut),
		windowMode: String(params.windowMode),
		enableDelay: String(LIMITS.CONSENT_ENABLE_DELAY),
	})
	consentWindow = window
	placeOnCursorDisplay(window, false)
	// Shown with focus: the presenter is about to decide, and the window starts with
	// "Decline" focused and the buttons disabled for a second
	onReadyToShow(window, () => window.show())

	return new Promise((resolve) => {
		let settled = false
		// eslint-disable-next-line prefer-const -- assigned after settle, which clears it
		let timeout: NodeJS.Timeout | undefined
		// eslint-disable-next-line prefer-const -- assigned after settle, which removes it
		let onResult: ((event: Electron.IpcMainEvent, result: { allow: boolean, clipboard: boolean }) => void) | undefined
		const settle = (result: ConsentResult) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timeout)
			ipcMain.removeListener('remoteControl:consentResult', onResult!)
			if (!window.isDestroyed()) {
				window.destroy()
			}
			if (consentWindow === window) {
				consentWindow = null
			}
			resolve(result)
		}
		onResult = (event, result) => {
			if (event.sender !== window.webContents) {
				return
			}
			settle({ allow: result.allow === true, clipboard: params.clipboard && result.clipboard === true, why: 'user' })
		}
		timeout = setTimeout(() => settle({ allow: false, clipboard: false, why: 'timeout' }), LIMITS.CONSENT_TIMEOUT)
		ipcMain.on('remoteControl:consentResult', onResult)
		window.once('closed', () => settle({ allow: false, clipboard: false, why: 'closed' }))
	})
}

/**
 * Close the consent window if it is open, which declines
 */
export function closeConsentWindow() {
	if (consentWindow && !consentWindow.isDestroyed()) {
		consentWindow.close()
	}
	consentWindow = null
}

/**
 * Whether the consent window is open
 */
export function isConsentWindowOpen() {
	return !!consentWindow && !consentWindow.isDestroyed()
}

/**
 * Show or update the "Controlled by" banner at the top of the screen under the cursor
 *
 * @param state - What the banner shows
 * @param onAction - Handler of the banner buttons
 */
export function showBanner(state: BannerState, onAction: (action: BannerAction) => void) {
	bannerState = state
	bannerActionHandler = onAction
	if (bannerWindow && !bannerWindow.isDestroyed()) {
		bannerWindow.webContents.send('remoteControl:banner', state)
		return
	}
	const window = createWindow('banner', { width: 520, height: 44 }, {})
	bannerWindow = window
	placeOnCursorDisplay(window, true)
	window.webContents.once('did-finish-load', () => {
		if (bannerState) {
			window.webContents.send('remoteControl:banner', bannerState)
		}
	})
	// Never take the focus from what the controller is working in
	onReadyToShow(window, () => window.showInactive())
	window.once('closed', () => {
		if (bannerWindow === window) {
			bannerWindow = null
		}
	})
}

/**
 * Hide the banner
 */
export function hideBanner() {
	bannerState = null
	bannerActionHandler = null
	if (bannerWindow && !bannerWindow.isDestroyed()) {
		bannerWindow.destroy()
	}
	bannerWindow = null
}

/**
 * Whether a window belongs to the remote control UI
 *
 * @param webContents - The sender of an IPC message
 */
function isBanner(webContents: Electron.WebContents) {
	return !!bannerWindow && !bannerWindow.isDestroyed() && bannerWindow.webContents === webContents
}

ipcMain.on('remoteControl:bannerAction', (event, action: BannerAction) => {
	if (isBanner(event.sender) && (action === 'take-back' || action === 'bring-to-front')) {
		bannerActionHandler?.(action)
	}
})

ipcMain.handle('remoteControl:bannerState', (event) => isBanner(event.sender) ? bannerState : null)
