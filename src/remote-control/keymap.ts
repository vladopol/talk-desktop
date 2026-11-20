/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2013 The Chromium Authors
 * SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause
 */

// GENERATED - do not edit by hand.
// Source: chromium/chromium ui/events/keycodes/dom/dom_code_data.inc
// (git blob 3c5ef403df1549ffe490609c0f6408b0a72598d6, fetched 2026-11-20), BSD-3-Clause, see LICENSES/BSD-3-Clause.txt.
// Only the keys a controller may press are kept (see REMOTE-CONTROL.md, "Key table").
// Pause (E1 prefix), power, media and browser keys are left out on purpose.

/**
 * A physical key on the presenter's OS.
 * win - the PS/2 set 1 scan code, 0xe0XX for the E0-prefixed (extended) keys;
 * mac - the kVK_* virtual key code;
 * linux - the evdev code (the X11 keycode is evdev + 8);
 * null where the OS has no such key.
 */
export type NativeKey = {
	win: number | null
	mac: number | null
	linux: number | null
}

/**
 * KeyboardEvent.code → native key, for the whitelisted keys only.
 */
export const KEYMAP: Readonly<Record<string, NativeKey>> = Object.freeze({
	KeyA: { win: 0x001e, mac: 0x00, linux: 0x001e },
	KeyB: { win: 0x0030, mac: 0x0b, linux: 0x0030 },
	KeyC: { win: 0x002e, mac: 0x08, linux: 0x002e },
	KeyD: { win: 0x0020, mac: 0x02, linux: 0x0020 },
	KeyE: { win: 0x0012, mac: 0x0e, linux: 0x0012 },
	KeyF: { win: 0x0021, mac: 0x03, linux: 0x0021 },
	KeyG: { win: 0x0022, mac: 0x05, linux: 0x0022 },
	KeyH: { win: 0x0023, mac: 0x04, linux: 0x0023 },
	KeyI: { win: 0x0017, mac: 0x22, linux: 0x0017 },
	KeyJ: { win: 0x0024, mac: 0x26, linux: 0x0024 },
	KeyK: { win: 0x0025, mac: 0x28, linux: 0x0025 },
	KeyL: { win: 0x0026, mac: 0x25, linux: 0x0026 },
	KeyM: { win: 0x0032, mac: 0x2e, linux: 0x0032 },
	KeyN: { win: 0x0031, mac: 0x2d, linux: 0x0031 },
	KeyO: { win: 0x0018, mac: 0x1f, linux: 0x0018 },
	KeyP: { win: 0x0019, mac: 0x23, linux: 0x0019 },
	KeyQ: { win: 0x0010, mac: 0x0c, linux: 0x0010 },
	KeyR: { win: 0x0013, mac: 0x0f, linux: 0x0013 },
	KeyS: { win: 0x001f, mac: 0x01, linux: 0x001f },
	KeyT: { win: 0x0014, mac: 0x11, linux: 0x0014 },
	KeyU: { win: 0x0016, mac: 0x20, linux: 0x0016 },
	KeyV: { win: 0x002f, mac: 0x09, linux: 0x002f },
	KeyW: { win: 0x0011, mac: 0x0d, linux: 0x0011 },
	KeyX: { win: 0x002d, mac: 0x07, linux: 0x002d },
	KeyY: { win: 0x0015, mac: 0x10, linux: 0x0015 },
	KeyZ: { win: 0x002c, mac: 0x06, linux: 0x002c },
	Digit1: { win: 0x0002, mac: 0x12, linux: 0x0002 },
	Digit2: { win: 0x0003, mac: 0x13, linux: 0x0003 },
	Digit3: { win: 0x0004, mac: 0x14, linux: 0x0004 },
	Digit4: { win: 0x0005, mac: 0x15, linux: 0x0005 },
	Digit5: { win: 0x0006, mac: 0x17, linux: 0x0006 },
	Digit6: { win: 0x0007, mac: 0x16, linux: 0x0007 },
	Digit7: { win: 0x0008, mac: 0x1a, linux: 0x0008 },
	Digit8: { win: 0x0009, mac: 0x1c, linux: 0x0009 },
	Digit9: { win: 0x000a, mac: 0x19, linux: 0x000a },
	Digit0: { win: 0x000b, mac: 0x1d, linux: 0x000b },
	Enter: { win: 0x001c, mac: 0x24, linux: 0x001c },
	Escape: { win: 0x0001, mac: 0x35, linux: 0x0001 },
	Backspace: { win: 0x000e, mac: 0x33, linux: 0x000e },
	Tab: { win: 0x000f, mac: 0x30, linux: 0x000f },
	Space: { win: 0x0039, mac: 0x31, linux: 0x0039 },
	Minus: { win: 0x000c, mac: 0x1b, linux: 0x000c },
	Equal: { win: 0x000d, mac: 0x18, linux: 0x000d },
	BracketLeft: { win: 0x001a, mac: 0x21, linux: 0x001a },
	BracketRight: { win: 0x001b, mac: 0x1e, linux: 0x001b },
	Backslash: { win: 0x002b, mac: 0x2a, linux: 0x002b },
	Semicolon: { win: 0x0027, mac: 0x29, linux: 0x0027 },
	Quote: { win: 0x0028, mac: 0x27, linux: 0x0028 },
	Backquote: { win: 0x0029, mac: 0x32, linux: 0x0029 },
	Comma: { win: 0x0033, mac: 0x2b, linux: 0x0033 },
	Period: { win: 0x0034, mac: 0x2f, linux: 0x0034 },
	Slash: { win: 0x0035, mac: 0x2c, linux: 0x0035 },
	CapsLock: { win: 0x003a, mac: 0x39, linux: 0x003a },
	F1: { win: 0x003b, mac: 0x7a, linux: 0x003b },
	F2: { win: 0x003c, mac: 0x78, linux: 0x003c },
	F3: { win: 0x003d, mac: 0x63, linux: 0x003d },
	F4: { win: 0x003e, mac: 0x76, linux: 0x003e },
	F5: { win: 0x003f, mac: 0x60, linux: 0x003f },
	F6: { win: 0x0040, mac: 0x61, linux: 0x0040 },
	F7: { win: 0x0041, mac: 0x62, linux: 0x0041 },
	F8: { win: 0x0042, mac: 0x64, linux: 0x0042 },
	F9: { win: 0x0043, mac: 0x65, linux: 0x0043 },
	F10: { win: 0x0044, mac: 0x6d, linux: 0x0044 },
	F11: { win: 0x0057, mac: 0x67, linux: 0x0057 },
	F12: { win: 0x0058, mac: 0x6f, linux: 0x0058 },
	PrintScreen: { win: 0xe037, mac: null, linux: 0x0063 },
	ScrollLock: { win: 0x0046, mac: null, linux: 0x0046 },
	Insert: { win: 0xe052, mac: 0x72, linux: 0x006e },
	Home: { win: 0xe047, mac: 0x73, linux: 0x0066 },
	PageUp: { win: 0xe049, mac: 0x74, linux: 0x0068 },
	Delete: { win: 0xe053, mac: 0x75, linux: 0x006f },
	End: { win: 0xe04f, mac: 0x77, linux: 0x006b },
	PageDown: { win: 0xe051, mac: 0x79, linux: 0x006d },
	ArrowRight: { win: 0xe04d, mac: 0x7c, linux: 0x006a },
	ArrowLeft: { win: 0xe04b, mac: 0x7b, linux: 0x0069 },
	ArrowDown: { win: 0xe050, mac: 0x7d, linux: 0x006c },
	ArrowUp: { win: 0xe048, mac: 0x7e, linux: 0x0067 },
	NumLock: { win: 0xe045, mac: 0x47, linux: 0x0045 },
	NumpadDivide: { win: 0xe035, mac: 0x4b, linux: 0x0062 },
	NumpadMultiply: { win: 0x0037, mac: 0x43, linux: 0x0037 },
	NumpadSubtract: { win: 0x004a, mac: 0x4e, linux: 0x004a },
	NumpadAdd: { win: 0x004e, mac: 0x45, linux: 0x004e },
	NumpadEnter: { win: 0xe01c, mac: 0x4c, linux: 0x0060 },
	Numpad1: { win: 0x004f, mac: 0x53, linux: 0x004f },
	Numpad2: { win: 0x0050, mac: 0x54, linux: 0x0050 },
	Numpad3: { win: 0x0051, mac: 0x55, linux: 0x0051 },
	Numpad4: { win: 0x004b, mac: 0x56, linux: 0x004b },
	Numpad5: { win: 0x004c, mac: 0x57, linux: 0x004c },
	Numpad6: { win: 0x004d, mac: 0x58, linux: 0x004d },
	Numpad7: { win: 0x0047, mac: 0x59, linux: 0x0047 },
	Numpad8: { win: 0x0048, mac: 0x5b, linux: 0x0048 },
	Numpad9: { win: 0x0049, mac: 0x5c, linux: 0x0049 },
	Numpad0: { win: 0x0052, mac: 0x52, linux: 0x0052 },
	NumpadDecimal: { win: 0x0053, mac: 0x41, linux: 0x0053 },
	IntlBackslash: { win: 0x0056, mac: 0x0a, linux: 0x0056 },
	ContextMenu: { win: 0xe05d, mac: 0x6e, linux: 0x007f },
	NumpadEqual: { win: 0x0059, mac: 0x51, linux: 0x0075 },
	F13: { win: 0x0064, mac: 0x69, linux: 0x00b7 },
	F14: { win: 0x0065, mac: 0x6b, linux: 0x00b8 },
	F15: { win: 0x0066, mac: 0x71, linux: 0x00b9 },
	F16: { win: 0x0067, mac: 0x6a, linux: 0x00ba },
	F17: { win: 0x0068, mac: 0x40, linux: 0x00bb },
	F18: { win: 0x0069, mac: 0x4f, linux: 0x00bc },
	F19: { win: 0x006a, mac: 0x50, linux: 0x00bd },
	F20: { win: 0x006b, mac: 0x5a, linux: 0x00be },
	F21: { win: 0x006c, mac: null, linux: 0x00bf },
	F22: { win: 0x006d, mac: null, linux: 0x00c0 },
	F23: { win: 0x006e, mac: null, linux: 0x00c1 },
	F24: { win: 0x0076, mac: null, linux: 0x00c2 },
	NumpadComma: { win: 0x007e, mac: 0x5f, linux: 0x0079 },
	IntlRo: { win: 0x0073, mac: 0x5e, linux: 0x0059 },
	IntlYen: { win: 0x007d, mac: 0x5d, linux: 0x007c },
	ControlLeft: { win: 0x001d, mac: 0x3b, linux: 0x001d },
	ShiftLeft: { win: 0x002a, mac: 0x38, linux: 0x002a },
	AltLeft: { win: 0x0038, mac: 0x3a, linux: 0x0038 },
	MetaLeft: { win: 0xe05b, mac: 0x37, linux: 0x007d },
	ControlRight: { win: 0xe01d, mac: 0x3e, linux: 0x0061 },
	ShiftRight: { win: 0x0036, mac: 0x3c, linux: 0x0036 },
	AltRight: { win: 0xe038, mac: 0x3d, linux: 0x0064 },
	MetaRight: { win: 0xe05c, mac: 0x36, linux: 0x007e },
})
