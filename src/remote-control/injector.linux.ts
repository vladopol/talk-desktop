/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type * as Koffi from 'koffi'
import type { ControlledSource, HitResult, Injector, KeyTargetResult, MouseButton, OsPoint, OsRect, WindowStateResult } from './injector.types.ts'
import type { NativeKey } from './keymap.ts'

import { clipboard, screen } from 'electron'

/*
 * X11 through the XTest extension. Wayland has no way for a client to inject input other than
 * the RemoteDesktop portal, which needs a system dialog for every session: not supported.
 * Coordinates are physical pixels of the root window.
 */

const XA_WINDOW = 33
const XA_CARDINAL = 6
const ANY_PROPERTY_TYPE = 0
const EVDEV_TO_X11_KEYCODE = 8
/** X11 buttons: 1 left, 2 middle, 3 right, 8 back, 9 forward */
const X11_BUTTONS = [1, 2, 3, 8, 9]
const WHEEL_UP = 4
const WHEEL_DOWN = 5
const WHEEL_LEFT = 6
const WHEEL_RIGHT = 7
const WHEEL_UNIT = 120
const RECURSION_LIMIT = 32
/** Windows thinner than this are the click-through strips of the screensharing indicator */
const INDICATOR_STRIP_MAX = 8

/** Set by KeePassXC and KDE's clipboard next to a secret */
const SENSITIVE_CLIPBOARD_TYPES = ['x-kde-passwordManagerHint']

type Pointer = unknown

type Bindings = {
	koffi: typeof Koffi
	display: Pointer
	root: number
	atoms: Record<'clientListStacking' | 'activeWindow' | 'wmPid' | 'wmState' | 'hidden' | 'transientFor', number>
	XFlush: (display: Pointer) => number
	XSync: (display: Pointer, discard: boolean) => number
	XFree: (data: Pointer) => number
	XDisplayWidth: (display: Pointer, screen: number) => number
	XDisplayHeight: (display: Pointer, screen: number) => number
	XGetGeometry: (display: Pointer, window: number, root: BigUint64Array, x: Int32Array, y: Int32Array, width: Uint32Array, height: Uint32Array, border: Uint32Array, depth: Uint32Array) => number
	XTranslateCoordinates: (display: Pointer, src: number, dest: number, x: number, y: number, destX: Int32Array, destY: Int32Array, child: BigUint64Array) => number
	XQueryPointer: (display: Pointer, window: number, root: BigUint64Array, child: BigUint64Array, rootX: Int32Array, rootY: Int32Array, winX: Int32Array, winY: Int32Array, mask: Uint32Array) => number
	XGetWindowProperty: (display: Pointer, window: number, property: number, offset: number, length: number, del: boolean, reqType: number, actualType: BigUint64Array, actualFormat: Int32Array, items: BigUint64Array, bytesAfter: BigUint64Array, prop: Pointer[]) => number
	XTestFakeMotionEvent: (display: Pointer, screen: number, x: number, y: number, delay: number) => number
	XTestFakeButtonEvent: (display: Pointer, button: number, press: boolean, delay: number) => number
	XTestFakeKeyEvent: (display: Pointer, keycode: number, press: boolean, delay: number) => number
}

let bindings: Bindings | null = null
let bindingsFailed = false

/**
 * Whether this is a Wayland session, where XTest only reaches XWayland windows
 */
export function isWaylandSession() {
	return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
}

/**
 * Lazily bind libX11 and libXtst
 */
function getBindings(): Bindings | null {
	if (bindings || bindingsFailed) {
		return bindings
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- koffi is a native module kept external from the bundle
		const koffi = require('koffi') as typeof Koffi
		const x11 = koffi.load('libX11.so.6')
		const xtst = koffi.load('libXtst.so.6')

		// A failing request on a window that has just been closed (BadWindow) would otherwise
		// end the whole process in Xlib's default error handler
		const XErrorHandler = koffi.proto('int RcXErrorHandler(void *display, void *event)')
		const XSetErrorHandler = x11.func('void *XSetErrorHandler(void *handler)')
		XSetErrorHandler(koffi.register(() => 0, koffi.pointer(XErrorHandler)))

		const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)')
		const XDefaultRootWindow = x11.func('unsigned long XDefaultRootWindow(void *display)')
		const XInternAtom = x11.func('unsigned long XInternAtom(void *display, const char *name, bool onlyIfExists)')
		const XTestQueryExtension = xtst.func('bool XTestQueryExtension(void *display, _Out_ int *event, _Out_ int *error, _Out_ int *major, _Out_ int *minor)')

		const display = XOpenDisplay(null)
		if (!display) {
			throw new Error('Cannot open the X display')
		}
		const out = () => new Int32Array(1)
		if (!XTestQueryExtension(display, out(), out(), out(), out())) {
			throw new Error('The X server has no XTest extension')
		}
		const atom = (name: string) => Number(XInternAtom(display, name, false))

		bindings = {
			koffi,
			display,
			root: Number(XDefaultRootWindow(display)),
			atoms: {
				clientListStacking: atom('_NET_CLIENT_LIST_STACKING'),
				activeWindow: atom('_NET_ACTIVE_WINDOW'),
				wmPid: atom('_NET_WM_PID'),
				wmState: atom('_NET_WM_STATE'),
				hidden: atom('_NET_WM_STATE_HIDDEN'),
				transientFor: atom('WM_TRANSIENT_FOR'),
			},
			XFlush: x11.func('int XFlush(void *display)'),
			XSync: x11.func('int XSync(void *display, bool discard)'),
			XFree: x11.func('int XFree(void *data)'),
			XDisplayWidth: x11.func('int XDisplayWidth(void *display, int screen)'),
			XDisplayHeight: x11.func('int XDisplayHeight(void *display, int screen)'),
			XGetGeometry: x11.func('int XGetGeometry(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *width, _Out_ unsigned int *height, _Out_ unsigned int *border, _Out_ unsigned int *depth)'),
			XTranslateCoordinates: x11.func('bool XTranslateCoordinates(void *display, unsigned long src, unsigned long dest, int x, int y, _Out_ int *destX, _Out_ int *destY, _Out_ unsigned long *child)'),
			XQueryPointer: x11.func('bool XQueryPointer(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)'),
			XGetWindowProperty: x11.func('int XGetWindowProperty(void *display, unsigned long window, unsigned long property, long offset, long length, bool del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *items, _Out_ unsigned long *bytesAfter, _Out_ void **prop)'),
			XTestFakeMotionEvent: xtst.func('int XTestFakeMotionEvent(void *display, int screen, int x, int y, unsigned long delay)'),
			XTestFakeButtonEvent: xtst.func('int XTestFakeButtonEvent(void *display, unsigned int button, bool press, unsigned long delay)'),
			XTestFakeKeyEvent: xtst.func('int XTestFakeKeyEvent(void *display, unsigned int keycode, bool press, unsigned long delay)'),
		}
	} catch (error) {
		console.error('[remote-control] Failed to load the X11 input bindings:', error)
		bindingsFailed = true
	}
	return bindings
}

/**
 * Injects input with XTest
 */
export class LinuxInjector implements Injector {
	readonly os = 'linux' as const

	private pressedKeys = new Set<number>()
	private pressedButtons = new Set<MouseButton>()
	/** Fractional wheel notches carried over to the next event, for smooth touchpads */
	private wheelRest = { dx: 0, dy: 0 }

	availability() {
		if (isWaylandSession()) {
			return { ok: false as const, why: 'unsupported' as const }
		}
		return getBindings() ? { ok: true as const } : { ok: false as const, why: 'bindings' as const }
	}

	requestPermission() {}

	sourceRect(source: ControlledSource): OsRect | null {
		const native = getBindings()
		if (!native) {
			return null
		}
		switch (source.kind) {
			case 'desktop':
				return { x: 0, y: 0, width: native.XDisplayWidth(native.display, 0), height: native.XDisplayHeight(native.display, 0) }
			case 'screen': {
				const display = screen.getAllDisplays().find((display) => String(display.id) === source.displayId)
				// Electron works in DIP, X11 in physical pixels
				return display ? { ...screen.dipToScreenRect(null, display.bounds) } : null
			}
			case 'window':
				return source.windowId ? this.windowRect(native, source.windowId) : null
		}
		return null
	}

	isOnScreen(point: OsPoint) {
		return screen.getAllDisplays().some((display) => contains(screen.dipToScreenRect(null, display.bounds), point))
	}

	hitTest(point: OsPoint, source: ControlledSource): HitResult {
		const native = getBindings()
		if (!native) {
			return 'outside'
		}
		const top = this.topClientAt(native, point)
		if (top === null) {
			// The desktop or a panel of the desktop environment
			return source.kind === 'window' ? 'window-occluded' : 'ok'
		}
		if (this.windowPid(native, top) === process.pid) {
			return 'own-window'
		}
		if (source.kind !== 'window') {
			return 'ok'
		}
		// Menus and popups are override-redirect windows outside the client list, so the
		// top client under a menu of the shared window is the shared window itself
		return this.belongsTo(native, top, source.windowId!) ? 'ok' : 'window-occluded'
	}

	keyTarget(source: ControlledSource): KeyTargetResult {
		const native = getBindings()
		if (!native) {
			return 'focus-elsewhere'
		}
		const active = this.windowProperty(native, native.root, native.atoms.activeWindow, XA_WINDOW)[0]
		if (!active) {
			return 'focus-elsewhere'
		}
		if (this.windowPid(native, active) === process.pid) {
			return 'own-window'
		}
		if (source.kind !== 'window') {
			return 'ok'
		}
		return this.belongsTo(native, active, source.windowId!) ? 'ok' : 'focus-elsewhere'
	}

	windowState(source: ControlledSource): WindowStateResult {
		const native = getBindings()
		if (!native || !source.windowId) {
			return 'normal'
		}
		if (!this.windowRect(native, source.windowId)) {
			return 'gone'
		}
		const state = this.windowProperty(native, source.windowId, native.atoms.wmState, ANY_PROPERTY_TYPE)
		return state.includes(native.atoms.hidden) ? 'hidden' : 'normal'
	}

	bringToFront() {
		// Needs a _NET_ACTIVE_WINDOW client message; window managers handle focus stealing
		// differently, left to the pilot
	}

	cursor(): OsPoint | null {
		const native = getBindings()
		if (!native) {
			return null
		}
		const x = new Int32Array(1)
		const y = new Int32Array(1)
		const ok = native.XQueryPointer(native.display, native.root, new BigUint64Array(1), new BigUint64Array(1), x, y, new Int32Array(1), new Int32Array(1), new Uint32Array(1))
		return ok ? { x: x[0]!, y: y[0]! } : null
	}

	move(point: OsPoint) {
		const native = getBindings()
		if (!native) {
			return
		}
		native.XTestFakeMotionEvent(native.display, -1, Math.round(point.x), Math.round(point.y), 0)
		native.XFlush(native.display)
	}

	button(button: MouseButton, down: boolean, point: OsPoint) {
		const native = getBindings()
		if (!native) {
			return
		}
		if (!down && !this.pressedButtons.has(button)) {
			return
		}
		this.move(point)
		this.sendButton(native, button, down)
	}

	wheel(dx: number, dy: number, point: OsPoint) {
		const native = getBindings()
		if (!native) {
			return
		}
		this.move(point)
		// X11 scrolls in whole notches, each a press and release of a wheel button
		this.wheelRest.dx += dx
		this.wheelRest.dy += dy
		const vertical = Math.trunc(this.wheelRest.dy / WHEEL_UNIT)
		const horizontal = Math.trunc(this.wheelRest.dx / WHEEL_UNIT)
		this.wheelRest.dy -= vertical * WHEEL_UNIT
		this.wheelRest.dx -= horizontal * WHEEL_UNIT
		const click = (button: number, count: number) => {
			for (let i = 0; i < Math.min(count, 10); i++) {
				native.XTestFakeButtonEvent(native.display, button, true, 0)
				native.XTestFakeButtonEvent(native.display, button, false, 0)
			}
		}
		click(vertical > 0 ? WHEEL_DOWN : WHEEL_UP, Math.abs(vertical))
		click(horizontal > 0 ? WHEEL_RIGHT : WHEEL_LEFT, Math.abs(horizontal))
		native.XFlush(native.display)
	}

	key(key: NativeKey, down: boolean) {
		const native = getBindings()
		if (!native || key.linux === null) {
			return
		}
		if (!down && !this.pressedKeys.has(key.linux)) {
			return
		}
		this.sendKey(native, key.linux, down)
	}

	releaseAll() {
		const native = getBindings()
		if (!native) {
			return
		}
		for (const key of [...this.pressedKeys]) {
			this.sendKey(native, key, false)
		}
		for (const button of [...this.pressedButtons]) {
			this.sendButton(native, button, false)
		}
		this.pressedKeys.clear()
		this.pressedButtons.clear()
		this.wheelRest = { dx: 0, dy: 0 }
	}

	clipboardSequence() {
		return null
	}

	async clipboardIsSensitive() {
		try {
			const found = await Promise.all(SENSITIVE_CLIPBOARD_TYPES.map((type) => clipboard.has(`electron application/osclipboard;format="${type}"`)))
			return found.some(Boolean)
		} catch {
			return true
		}
	}

	private sendButton(native: Bindings, button: MouseButton, down: boolean) {
		native.XTestFakeButtonEvent(native.display, X11_BUTTONS[button]!, down, 0)
		native.XFlush(native.display)
		if (down) {
			this.pressedButtons.add(button)
		} else {
			this.pressedButtons.delete(button)
		}
	}

	private sendKey(native: Bindings, evdev: number, down: boolean) {
		// The X server translates the keycode with the presenter's layout
		native.XTestFakeKeyEvent(native.display, evdev + EVDEV_TO_X11_KEYCODE, down, 0)
		native.XFlush(native.display)
		if (down) {
			this.pressedKeys.add(evdev)
		} else {
			this.pressedKeys.delete(evdev)
		}
	}

	/**
	 * A window property as a list of 32-bit items (returned as C longs by Xlib)
	 *
	 * @param native - Bindings
	 * @param window - Window
	 * @param property - Property atom
	 * @param type - Expected type atom, or AnyPropertyType
	 */
	private windowProperty(native: Bindings, window: number, property: number, type: number): number[] {
		const actualType = new BigUint64Array(1)
		const format = new Int32Array(1)
		const items = new BigUint64Array(1)
		const prop: Pointer[] = [null]
		const status = native.XGetWindowProperty(native.display, window, property, 0, 4096, false, type, actualType, format, items, new BigUint64Array(1), prop)
		if (status !== 0 || !prop[0]) {
			return []
		}
		try {
			const count = Number(items[0])
			if (format[0] !== 32 || count === 0) {
				return []
			}
			return (native.koffi.decode(prop[0], 'unsigned long', count) as (number | bigint)[]).map(Number)
		} finally {
			native.XFree(prop[0])
		}
	}

	private windowPid(native: Bindings, window: number) {
		return this.windowProperty(native, window, native.atoms.wmPid, XA_CARDINAL)[0] ?? 0
	}

	private windowRect(native: Bindings, window: number): OsRect | null {
		const width = new Uint32Array(1)
		const height = new Uint32Array(1)
		if (!native.XGetGeometry(native.display, window, new BigUint64Array(1), new Int32Array(1), new Int32Array(1), width, height, new Uint32Array(1), new Uint32Array(1))) {
			return null
		}
		const x = new Int32Array(1)
		const y = new Int32Array(1)
		if (!native.XTranslateCoordinates(native.display, window, native.root, 0, 0, x, y, new BigUint64Array(1))) {
			return null
		}
		return { x: x[0]!, y: y[0]!, width: width[0]!, height: height[0]! }
	}

	/**
	 * The topmost visible managed window at a point, from the window manager's stacking order
	 *
	 * @param native - Bindings
	 * @param point - Root coordinates
	 */
	private topClientAt(native: Bindings, point: OsPoint): number | null {
		const stacking = this.windowProperty(native, native.root, native.atoms.clientListStacking, XA_WINDOW)
		for (let i = stacking.length - 1; i >= 0; i--) {
			const window = stacking[i]!
			const rect = this.windowRect(native, window)
			if (!rect || !contains(rect, point)) {
				continue
			}
			// The click-through strips of the screensharing indicator
			if (Math.min(rect.width, rect.height) <= INDICATOR_STRIP_MAX && this.windowPid(native, window) === process.pid) {
				continue
			}
			const state = this.windowProperty(native, window, native.atoms.wmState, ANY_PROPERTY_TYPE)
			if (!state.includes(native.atoms.hidden)) {
				return window
			}
		}
		return null
	}

	/**
	 * The window itself, or a dialog whose WM_TRANSIENT_FOR chain leads to it
	 *
	 * @param native - Bindings
	 * @param window - A managed window
	 * @param shared - The shared window
	 */
	private belongsTo(native: Bindings, window: number, shared: number) {
		let current: number | undefined = window
		for (let i = 0; current && i < RECURSION_LIMIT; i++) {
			if (current === shared) {
				return true
			}
			current = this.windowProperty(native, current, native.atoms.transientFor, XA_WINDOW)[0]
		}
		return false
	}
}

/**
 * @param rect - Rectangle
 * @param point - Point
 */
function contains(rect: OsRect, point: OsPoint) {
	return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
}
