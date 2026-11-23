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
	windowMode: boolean
	state: 'active' | 'paused' | 'blocked'
	why: string | null
	/** The foreground window is elevated: the controller can neither click nor type into it */
	elevated: boolean
	clipboard: string | null
}

let consentWindow: BrowserWindow | null = null
let bannerWindow: BrowserWindow | null = null
let bannerState: BannerState | null = null
/** The banner has slid up out of the controller's way */
let bannerAway = false
let bannerHideTimer: NodeJS.Timeout | undefined
let bannerReturnTimer: NodeJS.Timeout | undefined

/** Distance around the banner within which the controller's cursor sends it away, DIP */
const BANNER_DODGE_MARGIN = 3
/** How long the cursor must stay away before the banner comes back, ms */
const BANNER_RETURN_DELAY = 600
/** The slide in RemoteControlBanner.vue, ms */
const BANNER_SLIDE_DURATION = 200
/*
 * The size of each window as requested, in DIP. It is never read back from the window: on Windows
 * with a display scale other than 100 % a frameless window comes back a pixel or so larger, and
 * a resize computed from that grows the window with every round (the consent window spread wide,
 * the banner grew down).
 */
const windowSizes = new WeakMap<BrowserWindow, { width: number, height: number }>()
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
		// The banner is transparent around its content, which slides out of the way
		backgroundColor: mode === 'banner' ? '#00000000' : BUILD_CONFIG.backgroundColor,
		transparent: mode === 'banner',
		frame: false,
		fullscreenable: false,
		icon: getBrowserWindowIcon(),
		maximizable: false,
		minimizable: false,
		resizable: false,
		show: false,
		skipTaskbar: mode === 'banner',
		// Windows keeps the caption style of a frameless window, with its minimum height
		thickFrame: false,
		titleBarStyle: 'hidden',
		type: isWindows ? 'toolbar' : isMac ? 'panel' : 'normal',
		webPreferences: {
			preload: TALK_DESKTOP__WINDOW_REMOTE_CONTROL_PRELOAD_WEBPACK_ENTRY,
			zoomFactor: getAppConfig('zoomFactor'),
		},
	})
	windowSizes.set(window, { width, height })
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
	const { width, height } = windowSizes.get(window)!
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
	bannerAway = false
	clearTimeout(bannerHideTimer)
	clearTimeout(bannerReturnTimer)
	bannerReturnTimer = undefined
	if (bannerWindow && !bannerWindow.isDestroyed()) {
		bannerWindow.destroy()
	}
	bannerWindow = null
}

/**
 * Slide the banner up while the controller's cursor is over it or near, so that what is under
 * it can be reached, and back once the cursor has left. Hidden at the end of the slide: an
 * invisible window would still take the clicks.
 *
 * @param controllerCursor - Whether the cursor is the controller's now, just injected; false
 * brings the banner back at once (the presenter took the mouse, the session paused)
 */
export function dodgeBanner(controllerCursor: boolean) {
	const window = bannerWindow
	if (!window || window.isDestroyed()) {
		return
	}
	let near = false
	if (controllerCursor) {
		const cursor = screen.getCursorScreenPoint()
		const bounds = window.getBounds()
		near = cursor.x >= bounds.x - BANNER_DODGE_MARGIN && cursor.x < bounds.x + bounds.width + BANNER_DODGE_MARGIN
			&& cursor.y >= bounds.y - BANNER_DODGE_MARGIN && cursor.y < bounds.y + bounds.height + BANNER_DODGE_MARGIN
	}
	if (near) {
		clearTimeout(bannerReturnTimer)
		bannerReturnTimer = undefined
		if (!bannerAway) {
			bannerAway = true
			window.webContents.send('remoteControl:bannerAway', true)
			bannerHideTimer = setTimeout(() => bannerAway && !window.isDestroyed() && window.hide(), BANNER_SLIDE_DURATION)
		}
		return
	}
	if (!bannerAway || (controllerCursor && bannerReturnTimer)) {
		return
	}
	clearTimeout(bannerReturnTimer)
	bannerReturnTimer = setTimeout(() => {
		bannerReturnTimer = undefined
		if (window.isDestroyed()) {
			return
		}
		bannerAway = false
		clearTimeout(bannerHideTimer)
		window.showInactive()
		window.webContents.send('remoteControl:bannerAway', false)
	}, controllerCursor ? BANNER_RETURN_DELAY : 0)
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

ipcMain.on('remoteControl:consentResize', (event, height: number) => {
	const window = consentWindow
	if (!window || window.isDestroyed() || event.sender !== window.webContents || !Number.isFinite(height)) {
		return
	}
	const size = windowSizes.get(window)!
	const newHeight = Math.min(Math.max(Math.ceil(height * window.webContents.getZoomFactor()), 120), 640)
	if (newHeight === size.height) {
		return
	}
	size.height = newHeight
	placeOnCursorDisplay(window, false)
})

ipcMain.on('remoteControl:bannerResize', (event, width: number) => {
	const window = bannerWindow
	if (!window || window.isDestroyed() || !isBanner(event.sender) || !Number.isFinite(width)) {
		return
	}
	const size = windowSizes.get(window)!
	const newWidth = Math.min(Math.max(Math.ceil(width * window.webContents.getZoomFactor()), 320), 960)
	if (newWidth === size.width) {
		return
	}
	// Only the width changes. Keep it centered where it is, the presenter may have dragged it aside.
	const { x, y } = window.getBounds()
	const center = x + size.width / 2
	size.width = newWidth
	window.setBounds({ x: Math.round(center - newWidth / 2), y, width: newWidth, height: size.height })
})

ipcMain.handle('remoteControl:bannerState', (event) => isBanner(event.sender) ? bannerState : null)
