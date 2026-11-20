/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { NativeKey } from './keymap.ts'
import type { RcOs, RcSourceKind } from './protocol.ts'

/**
 * A point in the OS's own global coordinates: physical pixels of the virtual desktop on
 * Windows, points of the global display space on macOS.
 */
export type OsPoint = { x: number, y: number }

/**
 * A rectangle in the same coordinates as OsPoint
 */
export type OsRect = { x: number, y: number, width: number, height: number }

/**
 * The shared source, resolved once when control is granted
 */
export type ControlledSource = {
	kind: RcSourceKind
	sourceId: string
	/** Native window id for a window share: HWND on Windows, CGWindowID on macOS */
	windowId: number | null
	/** Electron display id for a screen share */
	displayId: string | null
}

/** Where a pointer event would land */
export type HitResult = 'ok' | 'own-window' | 'window-occluded' | 'outside'

/** Where a key would go */
export type KeyTargetResult = 'ok' | 'own-window' | 'focus-elsewhere'

/** State of a shared window */
export type WindowStateResult = 'normal' | 'hidden' | 'gone'

/** A mouse button as in the protocol: 0 left, 1 middle, 2 right, 3 back, 4 forward */
export type MouseButton = 0 | 1 | 2 | 3 | 4

/**
 * Injects input into the OS. Only the main process has one.
 * Every method is synchronous and never throws: a failed call is reported by the return value.
 */
export interface Injector {
	readonly os: RcOs
	/** Whether injection is possible at all, and why not */
	availability(): { ok: true } | { ok: false, why: 'unsupported' | 'permission' | 'bindings' }
	/** Show the OS prompt for the permission, where there is one */
	requestPermission(): void
	/** The rectangle the frame of the source maps onto, or null if it cannot be resolved */
	sourceRect(source: ControlledSource): OsRect | null
	/** Whether a point is on any monitor (holes between monitors of different sizes are not) */
	isOnScreen(point: OsPoint): boolean
	/** Where a click at this point would land */
	hitTest(point: OsPoint, source: ControlledSource): HitResult
	/** Where a key press would go */
	keyTarget(source: ControlledSource): KeyTargetResult
	/** Whether a shared window is visible, hidden (minimised, another desktop) or closed */
	windowState(source: ControlledSource): WindowStateResult
	/** Restore and raise the shared window; only works while Talk is the foreground app */
	bringToFront(source: ControlledSource): void
	/** The current cursor position */
	cursor(): OsPoint | null
	move(point: OsPoint): void
	button(button: MouseButton, down: boolean, point: OsPoint, clickCount: number): void
	/** Scroll by dx, dy in 1/120 of a notch */
	wheel(dx: number, dy: number, point: OsPoint): void
	key(key: NativeKey, down: boolean): void
	/** Release every key and button this injector pressed and has not released yet */
	releaseAll(): void
	/** A number that changes whenever the clipboard changes, or null when unknown */
	clipboardSequence(): number | null
	/** Whether the clipboard holds content marked as sensitive by a password manager */
	clipboardIsSensitive(): Promise<boolean>
}
