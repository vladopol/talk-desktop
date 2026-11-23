/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type * as Koffi from 'koffi'
import type { ControlledSource, HitResult, Injector, KeyTargetResult, LeaveElevatedResult, ModifierState, MouseButton, OsPoint, OsRect, WindowStateResult } from './injector.types.ts'
import type { NativeKey } from './keymap.ts'

import { screen } from 'electron'
import { performance } from 'node:perf_hooks'

// See REMOTE-CONTROL.md, "Injecting input into the OS" - "Windows"
const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_XDOWN = 0x0080
const MOUSEEVENTF_XUP = 0x0100
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const XBUTTON1 = 1
const XBUTTON2 = 2
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_SCANCODE = 0x0008
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const MONITOR_DEFAULTTONULL = 0
const GA_ROOT = 2
const GA_ROOTOWNER = 3
const GW_OWNER = 4
const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00C00000
const WS_EX_TRANSPARENT = 0x00000020
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
const SW_RESTORE = 9
const SW_MINIMIZE = 6
const GW_HWNDNEXT = 2
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
const TOKEN_INTEGRITY_LEVEL_CLASS = 25
/** S-1-16-…: revision 1, one sub-authority, SECURITY_MANDATORY_LABEL_AUTHORITY */
const MANDATORY_LABEL_SID_PREFIX = [1, 1, 0, 0, 0, 0, 0, 16]
/** How long the integrity level of a process is trusted: moves come 60 times a second */
const INTEGRITY_CACHE_MS = 2000
const ZORDER_LIMIT = 512
/** How long to wait for a foreground change to show, and how often to look */
const FOREGROUND_CHECKS = 6
const FOREGROUND_CHECK_INTERVAL = 50
const MENU_CLASS = '#32768'
const OWNER_CHAIN_LIMIT = 32

/** Clipboard formats password managers put next to a secret, see "Shared clipboard" */
const SENSITIVE_CLIPBOARD_FORMATS = [
	'ExcludeClipboardContentFromMonitorProcessing',
	'Clipboard Viewer Ignore',
	// Set to a DWORD 0 by password managers. Reading the value needs OpenClipboard, so its
	// mere presence is treated as sensitive: ordinary applications do not set it at all.
	'CanIncludeInClipboardHistory',
	'CanUploadToCloudClipboard',
]

type Bindings = {
	koffi: typeof Koffi
	sizeofInput: number
	SendInput: (count: number, inputs: unknown, size: number) => number
	GetSystemMetrics: (index: number) => number
	MonitorFromPoint: (point: OsPoint, flags: number) => number
	GetMonitorInfoW: (monitor: number, info: Record<string, unknown>) => boolean
	WindowFromPoint: (point: OsPoint) => number
	GetAncestor: (hwnd: number, flags: number) => number
	GetWindow: (hwnd: number, cmd: number) => number
	GetWindowThreadProcessId: (hwnd: number, pid: Uint32Array) => number
	GetWindowLongW: (hwnd: number, index: number) => number
	GetClassNameW: (hwnd: number, buffer: Uint16Array, max: number) => number
	GetForegroundWindow: () => number
	IsWindow: (hwnd: number) => boolean
	IsIconic: (hwnd: number) => boolean
	DwmGetWindowAttribute: (hwnd: number, attribute: number, value: Int32Array, size: number) => number
	ShowWindow: (hwnd: number, cmd: number) => boolean
	SetForegroundWindow: (hwnd: number) => boolean
	GetCursorPos: (point: Record<string, number>) => boolean
	GetAsyncKeyState: (vk: number) => number
	IsWindowVisible: (hwnd: number) => boolean
	ShowWindowAsync: (hwnd: number, cmd: number) => boolean
	SwitchToThisWindow: (hwnd: number, altTab: boolean) => void
	GetShellWindow: () => number
	OpenProcess: (access: number, inherit: boolean, pid: number) => number
	CloseHandle: (handle: number) => boolean
	OpenProcessToken: (process: number, access: number, token: number[]) => boolean
	GetTokenInformation: (token: number, infoClass: number, info: Uint8Array, length: number, returned: Uint32Array) => boolean
	GetClipboardSequenceNumber: () => number
	RegisterClipboardFormatW: (name: string) => number
	IsClipboardFormatAvailable: (format: number) => boolean
}

let bindings: Bindings | null = null
let bindingsFailed = false

/**
 * Lazily bind user32 and dwmapi, in the style of src/app/nativeWindows.ts
 */
function getBindings(): Bindings | null {
	if (bindings || bindingsFailed) {
		return bindings
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- koffi is a native module kept external from the bundle
		const koffi = require('koffi') as typeof Koffi
		const user32 = koffi.load('user32.dll')
		const dwmapi = koffi.load('dwmapi.dll')
		const kernel32 = koffi.load('kernel32.dll')
		const advapi32 = koffi.load('advapi32.dll')

		koffi.struct('RC_POINT', { x: 'int32', y: 'int32' })
		koffi.struct('RC_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
		koffi.struct('RC_MONITORINFO', { cbSize: 'uint32', rcMonitor: 'RC_RECT', rcWork: 'RC_RECT', dwFlags: 'uint32' })
		koffi.struct('RC_MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'int32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
		koffi.struct('RC_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' })
		koffi.struct('RC_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
		koffi.union('RC_INPUT_UNION', { mi: 'RC_MOUSEINPUT', ki: 'RC_KEYBDINPUT', hi: 'RC_HARDWAREINPUT' })
		koffi.struct('RC_INPUT', { type: 'uint32', u: 'RC_INPUT_UNION' })

		bindings = {
			koffi,
			// 40 on x64. With a wrong size SendInput returns 0 and does nothing.
			sizeofInput: koffi.sizeof('RC_INPUT'),
			SendInput: user32.func('uint __stdcall SendInput(uint count, RC_INPUT *inputs, int size)'),
			GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
			MonitorFromPoint: user32.func('uintptr_t __stdcall MonitorFromPoint(RC_POINT point, uint flags)'),
			GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(uintptr_t monitor, _Inout_ RC_MONITORINFO *info)'),
			WindowFromPoint: user32.func('uintptr_t __stdcall WindowFromPoint(RC_POINT point)'),
			GetAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint flags)'),
			GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint cmd)'),
			GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'),
			GetWindowLongW: user32.func('long __stdcall GetWindowLongW(uintptr_t hwnd, int index)'),
			GetClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint16_t *buffer, int max)'),
			GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
			IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t hwnd)'),
			IsIconic: user32.func('bool __stdcall IsIconic(uintptr_t hwnd)'),
			DwmGetWindowAttribute: dwmapi.func('int __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint attribute, _Out_ int *value, uint size)'),
			ShowWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hwnd, int cmd)'),
			SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hwnd)'),
			GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ RC_POINT *point)'),
			GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vk)'),
			IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)'),
			ShowWindowAsync: user32.func('bool __stdcall ShowWindowAsync(uintptr_t hwnd, int cmd)'),
			SwitchToThisWindow: user32.func('void __stdcall SwitchToThisWindow(uintptr_t hwnd, bool altTab)'),
			GetShellWindow: user32.func('uintptr_t __stdcall GetShellWindow()'),
			OpenProcess: kernel32.func('uintptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
			CloseHandle: kernel32.func('bool __stdcall CloseHandle(uintptr_t handle)'),
			OpenProcessToken: advapi32.func('bool __stdcall OpenProcessToken(uintptr_t process, uint32 access, _Out_ uintptr_t *token)'),
			GetTokenInformation: advapi32.func('bool __stdcall GetTokenInformation(uintptr_t token, int infoClass, _Out_ uint8_t *info, uint32 length, _Out_ uint32_t *returned)'),
			GetClipboardSequenceNumber: user32.func('uint32 __stdcall GetClipboardSequenceNumber()'),
			RegisterClipboardFormatW: user32.func('uint __stdcall RegisterClipboardFormatW(str16 name)'),
			IsClipboardFormatAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint format)'),
		}
	} catch (error) {
		console.error('[remote-control] Failed to load the Windows input bindings:', error)
		bindingsFailed = true
	}
	return bindings
}

/**
 * Injects input with SendInput
 */
export class WindowsInjector implements Injector {
	readonly os = 'win' as const

	/** Pressed keys: scan code (with the 0xe0 prefix) */
	private pressedKeys = new Set<number>()
	/** Pressed mouse buttons */
	private pressedButtons = new Set<MouseButton>()
	private sensitiveFormats: number[] | null = null
	/** Integrity level of Talk itself: undefined until read, null when it cannot be read */
	private ownIntegrity: number | null | undefined = undefined
	private integrityCache = new Map<number, { level: number | null, at: number }>()

	availability() {
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
				return this.virtualDesktop(native)
			case 'screen': {
				const display = screen.getAllDisplays().find((display) => String(display.id) === source.displayId)
				if (!display) {
					return null
				}
				// Locate the monitor once through Electron, then take the exact physical
				// rectangle from the OS rather than recomputing scale factors
				const { x, y, width, height } = display.bounds
				const center = screen.dipToScreenPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) })
				const monitor = native.MonitorFromPoint(center, MONITOR_DEFAULTTONULL)
				if (!monitor) {
					return null
				}
				const info: Record<string, unknown> = { cbSize: 40, rcMonitor: {}, rcWork: {}, dwFlags: 0 }
				if (!native.GetMonitorInfoW(monitor, info)) {
					return null
				}
				return fromRect(info.rcMonitor as WinRect)
			}
			case 'window': {
				if (!source.windowId) {
					return null
				}
				// The visible frame, without the invisible resize borders GetWindowRect includes
				const rect = new Int32Array(4)
				if (native.DwmGetWindowAttribute(source.windowId, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) {
					return null
				}
				return fromRect({ left: rect[0]!, top: rect[1]!, right: rect[2]!, bottom: rect[3]! })
			}
		}
		return null
	}

	isOnScreen(point: OsPoint) {
		const native = getBindings()
		return !!native && native.MonitorFromPoint(point, MONITOR_DEFAULTTONULL) !== 0
	}

	hitTest(point: OsPoint, source: ControlledSource): HitResult {
		const native = getBindings()
		if (!native) {
			return 'outside'
		}
		const hwnd = native.WindowFromPoint(point)
		if (!hwnd) {
			return 'outside'
		}
		const root = native.GetAncestor(hwnd, GA_ROOT) || hwnd
		if (this.isOwnWindow(native, root)) {
			// The click-through strips of the screensharing indicator lie along the screen
			// edges, where the Start button and the taskbar are. The OS passes clicks
			// through them, so they must not block the click either.
			const exStyle = native.GetWindowLongW(root, GWL_EXSTYLE)
			return (exStyle & WS_EX_TRANSPARENT) && source.kind !== 'window' ? 'ok' : 'own-window'
		}
		if (this.isElevatedWindow(native, root)) {
			return 'elevated'
		}
		if (source.kind !== 'window') {
			return 'ok'
		}
		return this.belongsToSharedWindow(native, root, source.windowId!) ? 'ok' : 'window-occluded'
	}

	keyTarget(source: ControlledSource): KeyTargetResult {
		const native = getBindings()
		if (!native) {
			return 'focus-elsewhere'
		}
		const foreground = native.GetForegroundWindow()
		if (!foreground) {
			return 'focus-elsewhere'
		}
		const root = native.GetAncestor(foreground, GA_ROOT) || foreground
		if (this.isOwnWindow(native, root)) {
			// Injected M, V and Space would toggle the presenter's microphone and camera
			return 'own-window'
		}
		if (this.isElevatedWindow(native, root)) {
			return 'elevated'
		}
		if (source.kind !== 'window') {
			return 'ok'
		}
		const shared = source.windowId!
		const rootOwner = native.GetAncestor(foreground, GA_ROOTOWNER) || root
		if (rootOwner === shared || root === shared || this.isMenuOf(native, root, shared)) {
			return 'ok'
		}
		return 'focus-elsewhere'
	}

	windowState(source: ControlledSource): WindowStateResult {
		const native = getBindings()
		if (!native || !source.windowId) {
			return 'normal'
		}
		if (!native.IsWindow(source.windowId)) {
			return 'gone'
		}
		if (native.IsIconic(source.windowId)) {
			return 'hidden'
		}
		return this.isCloaked(native, source.windowId) ? 'hidden' : 'normal'
	}

	bringToFront(source: ControlledSource) {
		const native = getBindings()
		if (!native || !source.windowId || !native.IsWindow(source.windowId)) {
			return
		}
		if (native.IsIconic(source.windowId)) {
			native.ShowWindow(source.windowId, SW_RESTORE)
		}
		native.SetForegroundWindow(source.windowId)
	}

	foregroundElevated() {
		const native = getBindings()
		const root = native && this.foregroundRoot(native)
		return !!native && !!root && !this.isOwnWindow(native, root) && this.isElevatedWindow(native, root)
	}

	/**
	 * Neither SendInput nor Alt+Tab reaches an elevated foreground window, but the window
	 * manager calls are not input: switching to an ordinary window, then minimising the elevated
	 * one. Each step is checked, as both may be refused by the foreground lock.
	 *
	 * @param source - The shared source
	 */
	async leaveElevated(source: ControlledSource): Promise<LeaveElevatedResult> {
		const native = getBindings()
		if (!native) {
			return 'failed'
		}
		const root = this.foregroundRoot(native)
		if (!root || this.isOwnWindow(native, root) || !this.isElevatedWindow(native, root)) {
			return 'not-elevated'
		}
		const target = this.ordinaryWindowBelow(native, root, source)
		if (target) {
			if (native.IsIconic(target)) {
				native.ShowWindow(target, SW_RESTORE)
			}
			native.SwitchToThisWindow(target, true)
			if (await this.waitForegroundLeft(native, root)) {
				return 'switched'
			}
			native.SetForegroundWindow(target)
			if (await this.waitForegroundLeft(native, root)) {
				return 'switched'
			}
		}
		// SW_MINIMIZE also activates the next window in the Z order
		native.ShowWindowAsync(root, SW_MINIMIZE)
		return await this.waitForegroundLeft(native, root) ? 'minimized' : 'failed'
	}

	cursor(): OsPoint | null {
		const native = getBindings()
		const point = { x: 0, y: 0 }
		return native && native.GetCursorPos(point) ? point : null
	}

	modifiers(): ModifierState | null {
		const native = getBindings()
		if (!native) {
			return null
		}
		const held = (vk: number) => (native.GetAsyncKeyState(vk) & 0x8000) !== 0
		return {
			Control: held(VK_CONTROL),
			Alt: held(VK_MENU),
			Shift: held(VK_SHIFT),
			Meta: held(VK_LWIN) || held(VK_RWIN),
		}
	}

	move(point: OsPoint) {
		const native = getBindings()
		if (!native) {
			return
		}
		const desktop = this.virtualDesktop(native)
		const dx = Math.round((point.x - desktop.x) * 65535 / Math.max(desktop.width - 1, 1))
		const dy = Math.round((point.y - desktop.y) * 65535 / Math.max(desktop.height - 1, 1))
		this.sendMouse(native, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0, dx, dy)
	}

	button(button: MouseButton, down: boolean, point: OsPoint) {
		const native = getBindings()
		if (!native) {
			return
		}
		if (!down && !this.pressedButtons.has(button)) {
			// The button was pressed before control started
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
		// DOM: positive dy scrolls down; Windows: positive WHEEL scrolls up
		if (dy) {
			this.sendMouse(native, MOUSEEVENTF_WHEEL, Math.round(-dy))
		}
		if (dx) {
			this.sendMouse(native, MOUSEEVENTF_HWHEEL, Math.round(dx))
		}
	}

	key(key: NativeKey, down: boolean) {
		const native = getBindings()
		if (!native || key.win === null) {
			return
		}
		if (!down && !this.pressedKeys.has(key.win)) {
			// The key was held before control started
			return
		}
		this.sendKey(native, key.win, down)
	}

	releaseAll() {
		const native = getBindings()
		if (!native) {
			return
		}
		for (const scanCode of [...this.pressedKeys]) {
			this.sendKey(native, scanCode, false)
		}
		for (const button of [...this.pressedButtons]) {
			this.sendButton(native, button, false)
		}
		this.pressedKeys.clear()
		this.pressedButtons.clear()
	}

	clipboardSequence() {
		const native = getBindings()
		return native ? native.GetClipboardSequenceNumber() : null
	}

	async clipboardIsSensitive() {
		const native = getBindings()
		if (!native) {
			return true
		}
		this.sensitiveFormats ??= SENSITIVE_CLIPBOARD_FORMATS.map((name) => native.RegisterClipboardFormatW(name)).filter(Boolean)
		return this.sensitiveFormats.some((format) => native.IsClipboardFormatAvailable(format))
	}

	private virtualDesktop(native: Bindings): OsRect {
		return {
			x: native.GetSystemMetrics(SM_XVIRTUALSCREEN),
			y: native.GetSystemMetrics(SM_YVIRTUALSCREEN),
			width: native.GetSystemMetrics(SM_CXVIRTUALSCREEN),
			height: native.GetSystemMetrics(SM_CYVIRTUALSCREEN),
		}
	}

	private windowPid(native: Bindings, hwnd: number) {
		const pid = new Uint32Array(1)
		const thread = native.GetWindowThreadProcessId(hwnd, pid)
		return { pid: pid[0]!, thread }
	}

	private isOwnWindow(native: Bindings, hwnd: number) {
		return this.windowPid(native, hwnd).pid === process.pid
	}

	private foregroundRoot(native: Bindings) {
		const foreground = native.GetForegroundWindow()
		return foreground ? native.GetAncestor(foreground, GA_ROOT) || foreground : 0
	}

	private isCloaked(native: Bindings, hwnd: number) {
		const cloaked = new Int32Array(1)
		return native.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && !!cloaked[0]
	}

	/**
	 * Whether a top-level window belongs to a process with a higher integrity level than Talk
	 * (run as administrator), which UIPI keeps injected input away from. A process whose level
	 * cannot be read at all (its token is closed to Talk, a protected process) counts as one:
	 * input does not reach it either. If Talk's own level cannot be read, nothing is elevated,
	 * which is the behaviour without the check.
	 *
	 * @param native - Bindings
	 * @param root - A top-level window
	 */
	private isElevatedWindow(native: Bindings, root: number) {
		const { pid } = this.windowPid(native, root)
		if (!pid || pid === process.pid) {
			return false
		}
		if (this.ownIntegrity === undefined) {
			// Through a real handle like any other process: the pseudo handle of
			// GetCurrentProcess is -1, which does not fit a JS number as uintptr_t
			this.ownIntegrity = this.processIntegrity(native, process.pid)
		}
		if (this.ownIntegrity === null) {
			return false
		}
		const level = this.processIntegrity(native, pid)
		return level === null || level > this.ownIntegrity
	}

	private processIntegrity(native: Bindings, pid: number) {
		const now = performance.now()
		const cached = this.integrityCache.get(pid)
		if (cached && now - cached.at < INTEGRITY_CACHE_MS) {
			return cached.level
		}
		let level: number | null = null
		const handle = native.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if (handle) {
			try {
				level = this.tokenIntegrity(native, handle)
			} finally {
				native.CloseHandle(handle)
			}
		}
		if (this.integrityCache.size > 256) {
			this.integrityCache.clear()
		}
		this.integrityCache.set(pid, { level, at: now })
		return level
	}

	/**
	 * The mandatory integrity RID of a process token: 0x2000 medium, 0x3000 high, 0x4000 system
	 *
	 * @param native - Bindings
	 * @param processHandle - A process handle with PROCESS_QUERY_LIMITED_INFORMATION
	 */
	private tokenIntegrity(native: Bindings, processHandle: number): number | null {
		const token = [0]
		if (!native.OpenProcessToken(processHandle, TOKEN_QUERY, token) || !token[0]) {
			return null
		}
		try {
			// TOKEN_MANDATORY_LABEL: a pointer to the label SID, which follows in the same buffer
			const info = new Uint8Array(64)
			const returned = new Uint32Array(1)
			if (!native.GetTokenInformation(token[0], TOKEN_INTEGRITY_LEVEL_CLASS, info, info.length, returned)) {
				return null
			}
			return parseIntegritySid(info.subarray(0, Math.min(returned[0]!, info.length)))
		} finally {
			native.CloseHandle(token[0])
		}
	}

	/**
	 * Wait until the foreground is no longer the given elevated window
	 *
	 * @param native - Bindings
	 * @param root - The elevated window
	 */
	private async waitForegroundLeft(native: Bindings, root: number) {
		for (let i = 0; i < FOREGROUND_CHECKS; i++) {
			await new Promise((resolve) => setTimeout(resolve, FOREGROUND_CHECK_INTERVAL))
			const foreground = this.foregroundRoot(native)
			if (native.IsIconic(root) || (foreground && foreground !== root && !this.isElevatedWindow(native, foreground))) {
				return true
			}
		}
		return false
	}

	/**
	 * The window to switch to from an elevated one: the shared window for a window share, else
	 * the next ordinary application window below it in the Z order, else the desktop
	 *
	 * @param native - Bindings
	 * @param elevated - The elevated foreground window
	 * @param source - The shared source
	 */
	private ordinaryWindowBelow(native: Bindings, elevated: number, source: ControlledSource) {
		if (source.kind === 'window') {
			const shared = source.windowId
			return shared && native.IsWindow(shared) && !this.isElevatedWindow(native, shared) ? shared : 0
		}
		let hwnd = native.GetWindow(elevated, GW_HWNDNEXT)
		for (let i = 0; hwnd && i < ZORDER_LIMIT; i++, hwnd = native.GetWindow(hwnd, GW_HWNDNEXT)) {
			if (!native.IsWindowVisible(hwnd) || native.IsIconic(hwnd) || native.GetWindow(hwnd, GW_OWNER)) {
				continue
			}
			const style = native.GetWindowLongW(hwnd, GWL_STYLE) >>> 0
			const exStyle = native.GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0
			if ((style & WS_CAPTION) !== WS_CAPTION || (exStyle & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE))) {
				continue
			}
			if (this.isCloaked(native, hwnd) || this.isOwnWindow(native, hwnd) || this.isElevatedWindow(native, hwnd)) {
				continue
			}
			return hwnd
		}
		return native.GetShellWindow()
	}

	private className(native: Bindings, hwnd: number) {
		const buffer = new Uint16Array(64)
		const length = native.GetClassNameW(hwnd, buffer, buffer.length)
		return length > 0 ? Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le') : ''
	}

	/**
	 * A menu or a caption-less popup on the UI thread of the shared window
	 *
	 * @param native - Bindings
	 * @param hwnd - Top-level window at the point
	 * @param shared - The shared window
	 */
	private isMenuOf(native: Bindings, hwnd: number, shared: number) {
		if (this.windowPid(native, hwnd).thread !== this.windowPid(native, shared).thread) {
			return false
		}
		if (this.className(native, hwnd) === MENU_CLASS) {
			return true
		}
		const style = native.GetWindowLongW(hwnd, GWL_STYLE) >>> 0
		return (style & WS_POPUP) !== 0 && (style & WS_CAPTION) !== WS_CAPTION
	}

	/**
	 * The shared window itself, a window owned by it (dialogs, popups), or one of its menus.
	 * Not by process: browsers, Office and Explorer keep many top-level windows in one process,
	 * and a click would go blindly into another document lying on top of the shared one.
	 *
	 * @param native - Bindings
	 * @param root - Top-level window at the point
	 * @param shared - The shared window
	 */
	private belongsToSharedWindow(native: Bindings, root: number, shared: number) {
		let hwnd = root
		for (let i = 0; hwnd && i < OWNER_CHAIN_LIMIT; i++) {
			if (hwnd === shared) {
				return true
			}
			hwnd = native.GetWindow(hwnd, GW_OWNER)
		}
		return this.isMenuOf(native, root, shared)
	}

	private sendMouse(native: Bindings, flags: number, mouseData = 0, dx = 0, dy = 0) {
		const input = { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
		// Under UIPI (an elevated window at the point) SendInput fails silently; hitTest and
		// keyTarget answer 'elevated' for those windows, so that the session can tell
		native.SendInput(1, [input], native.sizeofInput)
	}

	private sendButton(native: Bindings, button: MouseButton, down: boolean) {
		const flags = [
			[MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
			[MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP],
			[MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
			[MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
			[MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP],
		][button]![down ? 0 : 1]!
		const mouseData = button === 3 ? XBUTTON1 : button === 4 ? XBUTTON2 : 0
		this.sendMouse(native, flags, mouseData)
		if (down) {
			this.pressedButtons.add(button)
		} else {
			this.pressedButtons.delete(button)
		}
	}

	private sendKey(native: Bindings, scanCode: number, down: boolean) {
		const extended = (scanCode & 0xff00) === 0xe000
		const flags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP)
		const input = { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: scanCode & 0xff, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
		native.SendInput(1, [input], native.sizeofInput)
		if (down) {
			this.pressedKeys.add(scanCode)
		} else {
			this.pressedKeys.delete(scanCode)
		}
	}
}

type WinRect = { left: number, top: number, right: number, bottom: number }

/**
 * The RID of the mandatory label SID S-1-16-RID found in a TOKEN_MANDATORY_LABEL buffer.
 * The SID is looked up by its fixed prefix rather than through the pointer in the structure.
 *
 * @param info - The buffer GetTokenInformation filled
 */
function parseIntegritySid(info: Uint8Array): number | null {
	const prefix = MANDATORY_LABEL_SID_PREFIX
	for (let i = 0; i + prefix.length + 4 <= info.length; i++) {
		if (prefix.every((byte, k) => info[i + k] === byte)) {
			const at = i + prefix.length
			return (info[at]! | (info[at + 1]! << 8) | (info[at + 2]! << 16) | (info[at + 3]! << 24)) >>> 0
		}
	}
	return null
}

/**
 * @param rect - A Win32 RECT
 */
function fromRect(rect: WinRect): OsRect {
	return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
}
