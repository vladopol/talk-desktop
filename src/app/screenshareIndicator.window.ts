/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Display, Rectangle, WebContents } from 'electron'
import type * as Koffi from 'koffi'

import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { rcLog } from '../remote-control/log.main.ts'
import { isMac, isWindows } from './system.utils.ts'

/**
 * Thickness of the indicator border in pixels (DIP).
 */
const BORDER_WIDTH = 1

/**
 * Color of the indicator border. The same yellow Chromium draws around a captured window,
 * so that sharing a window and sharing a screen look alike.
 */
const BORDER_COLOR = '#ffd500'

/**
 * The custom sourceId for capturing all the screens at once, see the screensharing dialog.
 */
const ENTIRE_DESKTOP_SOURCE_ID = 'entire-desktop:0:0'

/** SetWindowDisplayAffinity: shown on the monitor only, left out of every capture (Windows 10 2004+) */
const WDA_EXCLUDEFROMCAPTURE = 0x11
const GWL_EXSTYLE = -20
const WS_EX_TRANSPARENT = 0x20
const WS_EX_LAYERED = 0x80000

type AffinityApi = {
	SetWindowDisplayAffinity: (hwnd: number, affinity: number) => boolean
	GetWindowLongPtrW: (hwnd: number, index: number) => number | bigint
	SetWindowLongPtrW: (hwnd: number, index: number, value: number) => number | bigint
	GetLastError: () => number
}

let affinityApi: AffinityApi | null | undefined

/**
 * Bind the user32 functions to set the display affinity, Windows only
 */
function getAffinityApi(): AffinityApi | null {
	if (affinityApi !== undefined) {
		return affinityApi
	}
	affinityApi = null
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- koffi is a native module kept external from the bundle
		const koffi = require('koffi') as typeof Koffi
		const user32 = koffi.load('user32.dll')
		const kernel32 = koffi.load('kernel32.dll')
		affinityApi = {
			SetWindowDisplayAffinity: user32.func('bool __stdcall SetWindowDisplayAffinity(uintptr_t hwnd, uint32_t affinity)'),
			GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)'),
			SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t value)'),
			GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
		}
	} catch (error) {
		console.error('[screenshare-indicator] Failed to bind user32:', error)
	}
	return affinityApi
}

/**
 * Leave a strip out of the capture on Windows. Windows refuses WDA_EXCLUDEFROMCAPTURE for a
 * layered window (error 8, ERROR_NOT_ENOUGH_MEMORY), and the strips are layered for the
 * click-through - so setContentProtection fails there silently and the viewers saw the border.
 * Drop the layered style, set the affinity, then put the click-through back: the affinity stays.
 *
 * @param window - A border strip, shown
 */
function excludeFromCaptureOnWindows(window: BrowserWindow) {
	const api = isWindows ? getAffinityApi() : null
	if (!api || window.isDestroyed()) {
		return
	}
	const hwnd = Number(window.getNativeWindowHandle().readBigUInt64LE())
	const style = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
	api.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT))
	if (!api.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
		rcLog('indicator-not-excluded', { error: api.GetLastError(), exStyle: style.toString(16) })
	}
	window.setIgnoreMouseEvents(true)
}

/**
 * Windows currently painting the border, four (one per screen edge) per indicated display.
 */
let indicatorWindows: BrowserWindow[] = []

/**
 * The source currently being shared, or null if nothing is shared.
 * Kept to rebuild the indicator when the display configuration changes.
 */
let indicatedSourceId: string | null = null

/**
 * The Talk window that started sharing, to drop the indicator if that window goes away.
 */
let indicatorOwner: WebContents | null = null

/**
 * Whether the display change listeners have already been registered.
 */
let displayListenersRegistered = false

/**
 * The four edges of a display, as the bounds of the windows painting them.
 *
 * A border is drawn as four thin opaque windows rather than as one screen-sized transparent
 * window on purpose: transparency needs a working compositor and an alpha visual, and where
 * that is missing (Linux with some drivers) a screen-sized transparent window turns into a
 * black one covering the entire screen.
 *
 * @param display - The display to outline
 */
function getBorderBounds(display: Display): Rectangle[] {
	const { x, y, width, height } = display.bounds
	const thickness = Math.min(BORDER_WIDTH, Math.floor(Math.min(width, height) / 2))
	const innerHeight = Math.max(height - 2 * thickness, 1)

	return [
		{ x, y, width, height: thickness },
		{ x, y: y + height - thickness, width, height: thickness },
		{ x, y: y + thickness, width: thickness, height: innerHeight },
		{ x: x + width - thickness, y: y + thickness, width: thickness, height: innerHeight },
	]
}

/**
 * Create a click-through window painting one edge of the border.
 *
 * @param bounds - Where to place the window
 */
function createIndicatorWindow(bounds: Rectangle): BrowserWindow {
	const window = new BrowserWindow({
		...bounds,
		acceptFirstMouse: false,
		alwaysOnTop: true,
		backgroundColor: BORDER_COLOR,
		closable: false,
		// macOS otherwise pushes the window into the work area, which would move the border
		// off the screen edges and under the menu bar and the dock
		enableLargerThanScreen: true,
		focusable: false,
		frame: false,
		fullscreenable: false,
		hasShadow: false,
		maximizable: false,
		minimizable: false,
		// Electron clamps a window to its minimum size, which would make the border much
		// thicker than asked for
		minHeight: 1,
		minWidth: 1,
		movable: false,
		resizable: false,
		show: false,
		skipTaskbar: true,
		// Without the thick frame Windows also drops the caption style, which otherwise
		// imposes a minimum window height of a caption bar (some 30-40 px): the top strip
		// grew that much into the screen, the bottom one past its edge
		thickFrame: false,
		// A floating window type that takes no focus and does not show up in the task switcher
		type: isWindows ? 'toolbar' : isMac ? 'panel' : 'normal',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	})

	window.removeMenu()
	// Only for the presenter: kept out of the capture where the OS allows it. On Windows this
	// alone fails for a layered window, see excludeFromCaptureOnWindows. macOS honours it only
	// for captures without ScreenCaptureKit, which Chromium uses; Linux has no such thing.
	window.setContentProtection(true)
	// Should the OS still enforce a minimum size, only the requested strip is painted
	if (!isMac) {
		window.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }])
	}
	// The border is decoration only - every click has to reach whatever is below it
	window.setIgnoreMouseEvents(true)
	// 'screen-saver' is the level that also floats above full-screen applications
	window.setAlwaysOnTop(true, 'screen-saver')
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	// The window has no content: the background color is the border
	window.loadURL('data:text/html;charset=utf-8,')
	// showInactive to never steal the focus from whatever the user is presenting
	window.once('ready-to-show', () => {
		window.showInactive()
		excludeFromCaptureOnWindows(window)
	})

	return window
}

/**
 * Resolve the displays a shared source covers.
 *
 * `entire-desktop:0:0` captures every screen at once. A `screen:<id>:<index>` source captures
 * a single monitor, but its id maps to an Electron Display only through `display_id`, which is
 * empty on some platforms - there every display is outlined, which is still correct, only less
 * precise.
 *
 * @param sourceId - The screensharing sourceId being captured
 */
async function resolveIndicatedDisplays(sourceId: string): Promise<Display[]> {
	const displays = screen.getAllDisplays()

	if (sourceId === ENTIRE_DESKTOP_SOURCE_ID) {
		return displays
	}

	try {
		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: { width: 0, height: 0 },
		})
		const displayId = sources.find((source) => source.id === sourceId)?.display_id
		const display = displayId && displays.find((display) => String(display.id) === displayId)
		if (display) {
			return [display]
		}
	} catch (error) {
		console.error('[main] Failed to resolve the shared display:', error)
	}

	return displays
}

/**
 * Destroy all the indicator windows, leaving the shared source as is.
 */
function destroyIndicatorWindows() {
	for (const window of indicatorWindows) {
		// closable: false - the window can only be destroyed
		window.destroy()
	}
	indicatorWindows = []
}

/**
 * Re-create the indicator windows for the currently shared source.
 */
async function renderIndicator() {
	const sourceId = indicatedSourceId

	const displays = sourceId ? await resolveIndicatedDisplays(sourceId) : []

	// The share may have been stopped or replaced while the displays were being resolved
	if (indicatedSourceId !== sourceId) {
		return
	}

	destroyIndicatorWindows()
	indicatorWindows = displays.flatMap(getBorderBounds).map(createIndicatorWindow)
}

/**
 * Rebuild the indicator when monitors are plugged, unplugged, moved or resized, so that the
 * border does not stay behind on stale bounds.
 *
 * Registered lazily: the screen module must not be touched before the app is ready.
 */
function registerDisplayListeners() {
	if (displayListenersRegistered) {
		return
	}
	displayListenersRegistered = true

	const onDisplaysChanged = () => {
		if (indicatedSourceId) {
			renderIndicator()
		}
	}

	screen.on('display-added', onDisplaysChanged)
	screen.on('display-removed', onDisplaysChanged)
	screen.on('display-metrics-changed', onDisplaysChanged)
}

/**
 * Show or hide the screensharing indicator: a border along the edges of every shared screen.
 *
 * While the Talk window is minimized or covered, nothing else on the screen tells the user that
 * a screen is still being shared. Chromium draws such a border itself when a single window is
 * captured, but not when a screen is.
 *
 * @param sourceId - The screensharing sourceId being captured, or null when sharing stopped
 * @param owner - The Talk window that shares the screen
 */
export function setScreenshareIndicator(sourceId: string | null, owner: WebContents | null = null) {
	if (sourceId === indicatedSourceId) {
		return
	}

	indicatedSourceId = sourceId

	if (!sourceId) {
		indicatorOwner = null
		destroyIndicatorWindows()
		return
	}

	registerDisplayListeners()

	// A closed Talk window never reports the end of the share
	if (owner && owner !== indicatorOwner) {
		indicatorOwner = owner
		owner.once('destroyed', () => {
			if (indicatorOwner === owner) {
				setScreenshareIndicator(null)
			}
		})
	}

	renderIndicator()
}
